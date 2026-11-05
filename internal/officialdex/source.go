package officialdex

import (
	"fmt"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var dexPattern = regexp.MustCompile(`^NO\.([0-9]+)$`)
var sourceIDPattern = regexp.MustCompile(`^[1-9][0-9]*$`)
var categoryToLegacy = map[string]string{"物攻": "Physical Attack", "魔攻": "Magic Attack", "状态": "Status", "防御": "Defense"}
var categoryToWiki = map[string]string{"Physical Attack": "物攻", "Magic Attack": "魔攻", "Status": "状态", "Defense": "防御"}
var statFields = [][2]string{{"hp", "base_hp"}, {"atk", "base_phy_atk"}, {"matk", "base_mag_atk"}, {"df", "base_phy_def"}, {"mdf", "base_mag_def"}, {"spd", "base_spd"}}
var skillGroups = [][2]string{{"s", "默认"}, {"b", "血脉"}, {"t", "技能石"}}

type sourceMonster struct {
	id, name, full, form string
	dex                  int
	raw                  object
	identityOK           bool
	learnOK              bool
	skills               []sourceLearning
	valid                map[string]bool
}
type sourceLearning struct{ key, source string }
type sourceMove struct {
	name, key string
	raw       object
	valid     bool
}
type catalog struct {
	monsters  []*sourceMonster
	byID      map[string]*sourceMonster
	moves     map[string]*sourceMove
	moveOrder []string
	images    map[string]object
	listed    map[string]bool
	listCount int
}

func parseSource(data []byte, p *Proposal) (*catalog, error) {
	v, e := decode(data)
	if e != nil {
		return nil, fmt.Errorf("official JSON: %w", e)
	}
	r := asObject(v)
	if r == nil {
		return nil, fmt.Errorf("official catalog must be an object")
	}
	d := asObject(r["d"])
	l, ok := r["l"].([]any)
	elements, eok := r["e"].([]any)
	if d == nil || len(d) == 0 || !ok || len(l) == 0 || !eok || len(elements) == 0 {
		return nil, fmt.Errorf("official schema requires nonempty d object, l array, e array")
	}
	for _, v := range elements {
		if text(v) == "" {
			return nil, fmt.Errorf("official e must contain element names")
		}
	}
	c := &catalog{byID: map[string]*sourceMonster{}, moves: map[string]*sourceMove{}, images: map[string]object{}, listed: map[string]bool{}, listCount: len(l)}
	for _, key := range []string{"_em", "_tm", "_skm"} {
		if val, exists := r[key]; exists {
			m := asObject(val)
			if m == nil {
				return nil, fmt.Errorf("official %s must be an object", key)
			}
			c.images[key] = m
		}
	}
	ids := keys(d)
	sort.Slice(ids, func(i, j int) bool { a, _ := strconv.Atoi(ids[i]); b, _ := strconv.Atoi(ids[j]); return a < b })
	validIdentities := 0
	for _, id := range ids {
		if !sourceIDPattern.MatchString(id) {
			return nil, fmt.Errorf("invalid official detail ID %q", id)
		}
		n, err := strconv.ParseInt(id, 10, 64)
		if err != nil || n > 9007199254740991 {
			return nil, fmt.Errorf("invalid official detail ID %q", id)
		}
		m := asObject(d[id])
		if m == nil {
			return nil, fmt.Errorf("official d[%s] must be an object", id)
		}
		s := &sourceMonster{id: id, raw: m, valid: map[string]bool{}}
		c.byID[id] = s
		c.monsters = append(c.monsters, s)
		for _, key := range []string{"n", "nm", "fn", "f"} {
			value, ok := m[key].(string)
			s.valid[key] = ok && safeDisplayText(value, false) && (key == "f" || strings.TrimSpace(value) != "")
			if !s.valid[key] {
				p.issue("blocking", "invalid_identity", "monster", 0, id, text(m["nm"]), key, "身份字段缺失或非法；保留本地，不按ID或图片猜测")
			}
		}
		s.name = text(m["nm"])
		s.full = text(m["fn"])
		s.form = text(m["f"])
		if match := dexPattern.FindStringSubmatch(text(m["n"])); match != nil {
			s.dex, _ = strconv.Atoi(match[1])
		}
		s.identityOK = s.valid["n"] && s.valid["nm"] && s.valid["fn"] && s.valid["f"] && s.dex > 0
		expected := s.name
		if s.form != "" {
			expected += "（" + s.form + "）"
		}
		if normalizedDisplay(s.full) != normalizedDisplay(expected) {
			s.identityOK = false
			p.issue("blocking", "inconsistent_identity", "monster", 0, id, s.full, "fn", "详情fn与明确nm/f不一致")
		}
		if s.dex == 0 {
			p.issue("blocking", "invalid_dex_number", "monster", 0, id, s.full, "n", "缺少合法NO.图鉴编号")
		}
		if s.identityOK {
			validIdentities++
		}
		for _, pair := range statFields {
			value, ok := integer(m[pair[0]])
			s.valid[pair[0]] = ok && value > 0 && value <= 10000
			if !s.valid[pair[0]] {
				p.issue("warning", "invalid_field", "monster", 0, id, s.full, pair[0], "资质缺失或非法，不以0覆盖本地")
			}
		}
		for _, key := range []string{"e", "e2", "s", "tn", "te"} {
			value, ok := m[key].(string)
			s.valid[key] = ok && safeDisplayText(value, key == "te") && (strings.TrimSpace(value) != "" || key == "e2" || key == "s" && s.form == "首领形态")
			if !s.valid[key] {
				if key == "s" && ok && value == "" {
					p.issue("warning", "stage_source_incomplete", "monster", 0, id, s.full, key, "官方没有可用阶段候选；已有本地阶段保留，已审核新增使用未确认，不需要选择空值")
				} else {
					p.issue("warning", "invalid_field", "monster", 0, id, s.full, key, "字段缺失或非法，保留本地值")
				}
			}
		}
		if s.valid["s"] && s.form != "首领形态" {
			switch text(m["s"]) {
			case "一阶", "二阶", "最终形态":
			default:
				s.valid["s"] = false
				p.issue("warning", "unknown_stage", "monster", 0, id, s.full, "s", "未知阶段值，保留本地")
			}
		}
		if total, ok := integer(m["rt"]); ok {
			sum := 0
			all := true
			for _, pair := range statFields {
				val, _ := integer(m[pair[0]])
				sum += val
				all = all && s.valid[pair[0]]
			}
			if all && sum != total {
				p.issue("review", "stat_total_mismatch", "monster", 0, id, s.full, "rt", "官方总资质与明确六维之和不符；使用六维，不从总值猜属性")
			}
		}
		c.parseSkills(s, p)
	}
	if validIdentities == 0 {
		return nil, fmt.Errorf("official schema has no usable monster identities")
	}
	knownDetailPayload := false
	for _, s := range c.monsters {
		if asObject(s.raw["sk"]) != nil {
			knownDetailPayload = true
		}
		for _, pair := range statFields {
			if s.valid[pair[0]] {
				knownDetailPayload = true
			}
		}
	}
	if !knownDetailPayload {
		return nil, fmt.Errorf("official detail schema has neither recognizable stats nor skill objects")
	}
	for _, v := range l {
		m := asObject(v)
		if m == nil {
			return nil, fmt.Errorf("official list item must be an object")
		}
		i, ok := integer(m["i"])
		if !ok || i <= 0 {
			return nil, fmt.Errorf("official list i must be a positive numeric ID")
		}
		id := strconv.Itoa(i)
		if c.listed[id] {
			return nil, fmt.Errorf("duplicate official list ID %s", id)
		}
		c.listed[id] = true
		s := c.byID[id]
		if s == nil {
			return nil, fmt.Errorf("official list references absent detail %s", id)
		}
		for _, key := range []string{"n", "nm", "fn", "f"} {
			value, ok := m[key].(string)
			if !ok || normalizedDisplay(value) != normalizedDisplay(text(s.raw[key])) {
				s.identityOK = false
				p.issue("blocking", "list_identity_conflict", "monster", 0, id, s.full, key, "列表与详情身份字段不一致，拒绝映射")
			}
		}
	}
	// Validate whole relation lists separately from identity. A bad reference
	// disables that relation candidate, not unrelated monster fields or targets.
	for _, s := range c.monsters {
		for _, group := range []string{"forms", "evo"} {
			refs, ok := s.raw[group].([]any)
			s.valid[group] = ok
			seen := map[int]bool{}
			for _, value := range refs {
				ref := asObject(value)
				id, valid := integer(ref["i"])
				target := c.byID[strconv.Itoa(id)]
				if !valid || id <= 0 || target == nil || !target.identityOK || seen[id] {
					s.valid[group] = false
					continue
				}
				seen[id] = true
				for _, key := range []string{"nm", "fn"} {
					if text(ref[key]) == "" || normalizedDisplay(text(ref[key])) != normalizedDisplay(text(target.raw[key])) {
						s.valid[group] = false
					}
				}
				if group == "forms" {
					form, present := ref["f"].(string)
					if !present || normalizedDisplay(form) != normalizedDisplay(target.form) {
						s.valid[group] = false
					}
				}
			}
			if !s.valid[group] {
				field := "leader_of_id"
				if group == "evo" {
					field = "evolution_members"
				}
				p.issue("warning", "source_relationship_unavailable", "monster", 0, s.id, s.full, field, "官方关系缺失、非法、重复或身份引用不一致；没有可用源候选，保留本地关系")
			}
		}
	}
	return c, nil
}

func (c *catalog) parseSkills(s *sourceMonster, p *Proposal) {
	sk := asObject(s.raw["sk"])
	s.learnOK = sk != nil
	if sk == nil {
		p.issue("warning", "incomplete_learnset", "monster", 0, s.id, s.full, "sk", "学习面缺失或非法；不清空本地")
		return
	}
	for _, key := range keys(sk) {
		if key != "s" && key != "b" && key != "t" {
			s.learnOK = false
			p.issue("review", "unknown_learnset_source", "monster", 0, s.id, s.full, "sk."+key, "未知学习来源，不推断传说或其他来源")
		}
	}
	for _, group := range skillGroups {
		a, ok := sk[group[0]].([]any)
		if !ok {
			s.learnOK = false
			p.issue("warning", "incomplete_learnset", "monster", 0, s.id, s.full, "sk."+group[0], "来源数组缺失或非法；不视为空学习面")
			continue
		}
		for _, v := range a {
			m := asObject(v)
			name := text(m["nm"])
			key := NormalizeName(name)
			if key == "" {
				s.learnOK = false
				p.issue("blocking", "invalid_move", "monster", 0, s.id, s.full, "sk."+group[0], "技能缺少合法名称")
				continue
			}
			valid := true
			for _, f := range []string{"nm", "tp", "el", "ef"} {
				str, ok := m[f].(string)
				valid = valid && ok && safeDisplayText(str, f == "ef") && strings.TrimSpace(str) != ""
			}
			ec, ecOK := numericString(m["ec"], false)
			if cost, ok := integer(ec); !ok || cost > 10000 {
				ecOK = false
			}
			_, pwOK := numericString(m["pw"], true)
			valid = valid && ecOK && pwOK && categoryToLegacy[text(m["tp"])] != ""
			if text(m["pw"]) == "" && (text(m["tp"]) == "物攻" || text(m["tp"]) == "魔攻") {
				valid = false
			}
			definition := object{}
			for _, f := range []string{"tp", "el", "ec", "pw", "ef"} {
				definition[f] = m[f]
			}
			if prior := c.moves[key]; prior != nil {
				if !equal(prior.raw, definition) || !valid {
					if prior.valid {
						p.issue("blocking", "move_definition_conflict", "move", 0, "", name, "definition", "同一规范技能名出现冲突或不完整定义；该技能全局拒绝更新")
					}
					prior.valid = false
				}
			} else {
				c.moves[key] = &sourceMove{name, key, definition, valid}
				c.moveOrder = append(c.moveOrder, key)
				if !valid {
					p.issue("blocking", "invalid_move", "move", 0, "", name, "definition", "官方技能字段缺失/非法，不以0、空描述或空属性覆盖")
				}
			}
			if !valid {
				s.learnOK = false
			}
			s.skills = append(s.skills, sourceLearning{key, group[1]})
		}
	}
}

// TrustedImageURL resolves only explicit source paths below the matching asset
// namespace. It disallows traversal (including encoded separators), userinfo,
// fragments, arbitrary query strings, and other hosts; it does not perform IO.
func TrustedImageURL(raw, purpose string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || raw == "" || strings.Contains(raw, "\\") {
		return "", fmt.Errorf("invalid image URL")
	}
	if u.User != nil || u.Fragment != "" {
		return "", fmt.Errorf("image URL contains userinfo/fragment")
	}
	base, _ := url.Parse(ImageBaseURL)
	resolved := base.ResolveReference(u)
	if resolved.Scheme != "https" || resolved.Host != base.Host {
		return "", fmt.Errorf("image URL outside trusted host")
	}
	namespace := map[string]string{"monster": "i", "wiki": "i", "move": "s", "trait": "t", "type": "e"}[purpose]
	if namespace == "" {
		return "", fmt.Errorf("unknown image purpose")
	}
	prefix := base.Path + "a/" + namespace + "/"
	if !strings.HasPrefix(resolved.Path, prefix) || path.Clean(resolved.Path) != resolved.Path || strings.Contains(resolved.Path, "\\") || strings.Contains(resolved.Path, "%") {
		return "", fmt.Errorf("image path outside trusted namespace")
	}
	if strings.Contains(strings.TrimPrefix(resolved.Path, prefix), "/") || !strings.EqualFold(path.Ext(resolved.Path), ".png") {
		return "", fmt.Errorf("image path is not a direct PNG asset")
	}
	q, err := url.ParseQuery(resolved.RawQuery)
	if err != nil {
		return "", err
	}
	for k, values := range q {
		if k != "v" || len(values) != 1 || !regexp.MustCompile(`^[a-fA-F0-9]{1,64}$`).MatchString(values[0]) {
			return "", fmt.Errorf("unexpected image query")
		}
	}
	return resolved.String(), nil
}
