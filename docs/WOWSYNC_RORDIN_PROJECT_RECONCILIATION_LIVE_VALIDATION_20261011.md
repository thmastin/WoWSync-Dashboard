# Rordin Project Reconciliation: DEV Live Validation

Date: 2026-10-11

## Deployment

The guarded DEV deployment promoted the reviewed commit
`791ed13ed307e79c2d30ed1f839586f7763a642c` from
`feature/forever-gear-observation`. The preceding DEV release was
`74edd84bd64762f9cb80bd48951fa97f063648f2`.

The deployment tool reported `DEPLOYED` and a validated `PROMOTE_SUCCESS`.
Its schema classification was `NONE`: no application objects were added,
removed, or changed, and `user_version` remained `0`. The workflow's backup
was `/var/lib/wowsync-dev/backups/deploy/20261011T183409.485Z-f465912f-74edd84bd64762f9cb80bd48951fa97f063648f2-to-791ed13ed307e79c2d30ed1f839586f7763a642c.sqlite`;
the recorded SHA-256 was
`8e59d04e06817318e6ca245b621250deed78edcabab7804f6050171738494982`, and
SQLite integrity returned `ok`.

After deployment, `releases/current` resolved to the deployed SHA. Dashboard
and MCP tunnel services were active/running, and HTTP checks for `/` and
`/api/versions` returned 200. The deployment status reported `healthy: true`.

## Rordin evidence and project state

The existing Forever project is
`project_goal_30357e44148dd5dbc3dcbca4ca8afc98a73898c5dc8b039d70f41baa68fe7bde`.
It remained ACTIVE at revision 2 with two history events throughout this
read-only validation.

The requested real snapshot 164 was retrieved from the DEV Dashboard API. It
belongs to Rordin Longbraid on Forever and records a complete professions
section with:

- Mining: 3/75
- Blacksmithing: 1/75

The connected MCP's current profession readback reported the same values;
its latest imported snapshot was 165. The deployed project's profession
review recognized both linked skill requirements as currently met by recent
observations. This evidence establishes current recorded skill only. It does
not establish when or how either profession was learned, nor recipe knowledge
or craftability. Recipe knowledge remains unknown.

The actual Dashboard project page displayed “Current profession evidence” for
the Mining and Blacksmithing work orders. Both showed current linked needs met,
while the work-order status remained PLANNED. The page directed the player to
review the existing prerequisite work order before proposing a status change.
No status proposal was created, approved, or committed in this checkpoint.

Read-only MCP and Dashboard checks left the project at revision 2 with its two
existing history events. The recorded review work order remained IN_PROGRESS;
the Mining and Blacksmithing work orders remained PLANNED. No project data was
changed by viewing the evidence.

The connected MCP project readback succeeded, and the existing project
approval model was visible as a required player-approved Dashboard change.
The approval/commit path itself was deliberately not exercised and is not
claimed as live-validated.

## Isolation and limits

Version listing continued to distinguish Forever, Retail, Classic Era, and
TBC Anniversary. A Retail-only character read returned the Retail character
set, separate from Rordin's Forever evidence. No unrelated project or
cross-version data was mutated.

The requested operational checkpoint
`WOWSYNC_RORDIN_PROJECT_LIFECYCLE_20261011.md` and the canonical truth checkout
were not available in the Omarchy environment during this operation. The
Windows path `D:\dev\wow-stuff\truth\` was not mounted, and the connected
operational-truth document registry returned no documents. This record
therefore captures the evidence observed directly in DEV; it does not claim
that the unavailable canonical truth repository was updated.

No GearExport or production change was made. This validation did not exercise
recipe capture, profession learning, or project approval/commit.

## Next checkpoint

The player should review the named prerequisite work order in the Dashboard.
Only after that review should the player decide whether to initiate a
Dashboard progress proposal for Mining and Blacksmithing. Do not treat the
observed skill values as recipe or crafting evidence. Recipe capture remains
a separate implementation and validation milestone.
