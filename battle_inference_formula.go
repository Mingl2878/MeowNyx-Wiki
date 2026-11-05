package main

import (
	"errors"
	"math/big"
	"strconv"
	"strings"
)

// BattleDamageFormula is a hit-local declaration, not catalog defaults. Missing
// numeric pointers and false verification flags remain unknown. Power already
// includes every power-side rule (including dynamic/wish branches); the remaining
// factors are applied once, before the final floor, without intermediate rounding.
type BattleDamageFormula struct {
	AttackCategory    string   `json:"attackCategory"`
	Power             *float64 `json:"power,omitempty"`
	AttackMultiplier  *float64 `json:"attackMultiplier,omitempty"`
	DefenseMultiplier *float64 `json:"defenseMultiplier,omitempty"`
	Reduction         *float64 `json:"reduction,omitempty"`
	Effectiveness     *float64 `json:"effectiveness,omitempty"`
	AttackerMonsterID int      `json:"attackerMonsterId"`
	DefenderMonsterID int      `json:"defenderMonsterId"`
	AttackerLevel     int      `json:"attackerLevel"`
	DefenderLevel     int      `json:"defenderLevel"`
	ModifiersVerified bool     `json:"modifiersVerified"`
	SingleHit         bool     `json:"singleHit"`
	HPLossVerified    bool     `json:"hpLossVerified"`
	Evidence          []string `json:"evidence"`
}

func battleInferenceFormulaClone(f *BattleDamageFormula) *BattleDamageFormula {
	if f == nil {
		return nil
	}
	v := *f
	v.Power = battleCombatCopy(f.Power)
	v.AttackMultiplier = battleCombatCopy(f.AttackMultiplier)
	v.DefenseMultiplier = battleCombatCopy(f.DefenseMultiplier)
	v.Reduction = battleCombatCopy(f.Reduction)
	v.Effectiveness = battleCombatCopy(f.Effectiveness)
	v.Evidence = append([]string(nil), f.Evidence...)
	return &v
}

func battleInferenceFormulaValid(e BattleEvent) error {
	if e.Combat == nil || e.Combat.DamageFormula == nil {
		return nil
	}
	f := e.Combat.DamageFormula
	if e.Kind != "damage" || e.Phase != "executed" || e.Combat.ActionID == "" {
		return errors.New("damage formula requires linked executed damage")
	}
	if !battleOneOf(f.AttackCategory, "physical", "magic") || f.AttackerMonsterID < 1 || f.DefenderMonsterID < 1 || f.AttackerMonsterID > 1000000000 || f.DefenderMonsterID > 1000000000 || f.AttackerLevel < 1 || f.AttackerLevel > 99 || f.DefenderLevel < 1 || f.DefenderLevel > 99 {
		return errors.New("invalid damage formula identity, category or level")
	}
	for _, x := range []*float64{f.Power, f.AttackMultiplier, f.DefenseMultiplier} {
		if x != nil && (!battleFinite(*x, 0, 1000000) || *x <= 0) {
			return errors.New("invalid damage formula power or multiplier")
		}
	}
	if f.Reduction != nil && (!battleFinite(*f.Reduction, 0, 1) || *f.Reduction <= 0) {
		return errors.New("invalid damage formula reduction")
	}
	if f.Effectiveness != nil && (!battleFinite(*f.Effectiveness, 0, 64) || *f.Effectiveness <= 0) {
		return errors.New("invalid damage formula effectiveness")
	}
	if e.Combat.Effectiveness != nil && f.Effectiveness != nil && *e.Combat.Effectiveness != *f.Effectiveness {
		return errors.New("conflicting formula effectiveness")
	}
	if len(f.Evidence) > 16 {
		return errors.New("damage formula evidence exceeds limit")
	}
	for _, s := range f.Evidence {
		if len(s) > 512 || strings.TrimSpace(s) == "" {
			return errors.New("invalid damage formula provenance")
		}
	}
	return nil
}

func battleInferenceFormulaComplete(e BattleEvent) bool {
	if battleInferenceFormulaValid(e) != nil || e.Combat == nil || e.Combat.DamageFormula == nil {
		return false
	}
	f := e.Combat.DamageFormula
	return f.ModifiersVerified && f.SingleHit && f.HPLossVerified && len(f.Evidence) > 0 && f.Power != nil && f.AttackMultiplier != nil && f.DefenseMultiplier != nil && f.Reduction != nil && f.Effectiveness != nil
}

// Decimal inputs are exact rationals just like BattleMath.floorRatio. Converting
// shortest decimal representations, rather than binary float fractions, preserves
// integer boundaries (41*37/41) and explicit decimal modifiers.
func battleInferenceRatio(factors, divisors []float64, round bool) int {
	n := big.NewRat(1, 1)
	for _, values := range []struct {
		xs     []float64
		divide bool
	}{{factors, false}, {divisors, true}} {
		for _, v := range values.xs {
			q, ok := new(big.Rat).SetString(strconv.FormatFloat(v, 'g', -1, 64))
			if !ok || values.divide && q.Sign() == 0 {
				return -1
			}
			if values.divide {
				n.Quo(n, q)
			} else {
				n.Mul(n, q)
			}
		}
	}
	if round {
		n.Add(n, big.NewRat(1, 2))
	}
	z, remainder := new(big.Int), new(big.Int)
	z.QuoRem(n.Num(), n.Denom(), remainder)
	if n.Sign() < 0 && remainder.Sign() != 0 {
		z.Sub(z, big.NewInt(1))
	}
	if !z.IsInt64() {
		return -1
	}
	i := z.Int64()
	if i > 2147483647 || i < 0 {
		return -1
	}
	return int(i)
}

func battleInferenceStat(base int, stat string, nature, iv, level int) int {
	if base < 0 || base > 10000 || iv < 0 || iv > 60 || nature < 0 || nature > 2 || level < 1 || level > 99 {
		return -1
	}
	coef, add, outside := level+50, 10, 50
	if stat == "hp" {
		coef, add, outside = 2*level+50, level+10, 100
	}
	scaled := battleInferenceRatio([]float64{float64(coef), float64(base) + float64(iv)/2}, []float64{100}, true)
	percent := []float64{100, 120, 90}[nature]
	return battleInferenceRatio([]float64{float64(scaled + add), percent}, []float64{100}, true) + outside
}

func battleInferenceDamage(attack, power, defense, reduction, effectiveness, attackMult, defenseMult float64, level int) int {
	return battleInferenceRatio([]float64{power, attack, float64(1000 + 45*level), reduction, effectiveness, attackMult}, []float64{4100, defense, defenseMult}, false)
}
