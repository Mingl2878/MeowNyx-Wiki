# Developer-only local deletion and Tencent recovery

This is an explicit recovery-test setup, **not** a startup migration or a damaged
factory dataset. Keep the bundled canonical catalog complete. The UI restores
records only after the user checks Tencent, selects the missing entities, and
confirms Apply.

## Identity and preservation contract

`extensions.monster_identity_reservations` version 1 contains only
`local_id`, `provider`, `source_id`, and semantic `identity`. It does not retain
monster business data or learnsets. Unknown versions, duplicate claims, source
tuple changes, and occupied IDs belonging to another identity are rejected.
Reservations persist after restoration and protect subsequent allocations.

The deletion helper removes only explicitly named monster/learnset records and
precise dangling ordinary/leader/member references. Surviving children that
inherit from a deleted parent become `own` with their **effective** learning,
not stale stored rows. A surviving variant depending on a deleted main form is
refused rather than guessed. Shared skills, traits, types, rules, all source
baseline entries, choice policies, and unrelated catalog metadata remain intact.
No personal configuration, team, favorite, image, or battle-record file is opened.

Only reserved missing entities bypass the unchanged-source baseline. An ordinary
source-only entity the user previously declined is still acknowledged normally.
Recovery proposals require the same independent completeness/identity checks as
ordinary additions; a reservation is never a source-number-only fallback.

## Candidate or audit, without local-store writes

Run from the project directory. The output must be a new file in an existing,
explicitly chosen directory; in-place and overwrite operations are refused.
Omit `-out` for an audit only.

```powershell
go run ./cmd/catalogdelete -catalog 'D:\echoagent\MeowNyx Wiki\data\catalog.json' -names '机械方方,多彩方方,立方人' -out '<new-isolated-candidate.json>'
```

## Explicit local-store transaction

The developer must first close the app normally and wait for saves to finish.
The CLI does not close the app or discover AppData. Both store and backup paths
must be explicit absolute paths in separate directory trees.

First audit the **current local snapshot**, using the bundled catalog only when
there is no active local pointer. This command writes neither store nor backup:

```powershell
go run ./cmd/catalogdelete -catalog '<bundled-catalog.json>' -names '机械方方,多彩方方,立方人' -store-root '<absolute-local-catalog-dir>' -backup-dir '<absolute-external-backup-dir>'
```

Review `deletion.removed` and capture `current_revision`. Then repeat with:

```powershell
# Add to the audited command; do not also pass -out:
-commit-local -app-closed -expected-revision '<exact-current_revision>'
```

The tool rereads current data, rejects a stale revision, creates a fresh candidate,
and uses the existing immutable-store transaction: durable previous-data backup,
immutable versions, then atomic active-pointer replacement. It refuses a store
that fell back to its previous pointer. The source/bundled input stays unchanged.
The final local state remains deleted; the tool never restores it.

## Tests

All mutable stores and backups use `t.TempDir`. The optional real-source test
reads explicit input paths, creates deletion only inside that isolated fixture,
and exercises the actual check / cancel / select / Apply API. It checks stable
original IDs, retained policy/shared data, and a quiet second check. It does not
assert permanent absence from factory data.

```powershell
go test ./internal/catalogrecovery ./internal/officialdex ./cmd/catalogdelete ./cmd/catalogctl
$env:CATALOG_RECOVERY_CATALOG = '<complete-catalog.json>'
$env:CATALOG_RECOVERY_SOURCE = '<source-official.json>'
go test . -run 'TestCanonicalDeletionOfficialRecovery|TestTencentBaselineNewEntitiesUseSemanticIdentityAcrossIDAllocation' -count=1 -v
```
