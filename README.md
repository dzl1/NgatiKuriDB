# Harbour — Ngāti Kuri database entries

Harbour is the staff browser for the beneficiary management database. The data lives in **Azure SQL in New Zealand North**, and staff sign in with their Microsoft Entra ID work account.

The app opens at **Database Entries → List All**, sorted by last name, then first name. Use the name control to switch between A–Z and Z–A, or choose **List by DOB** to sort earliest to latest using the date-of-birth field. DOB values display as `M/D/YYYY`, matching the Access screen (for example, `9/20/1935`). **Export all users** downloads a CSV with one row per person, their main fields, and linked records in numbered table-field columns. Applicant Status IDs are accompanied by their lookup labels in the profile and export. Select a person to see their main Contact Details and related Attachments, Emails, All Notes, Funding Applications, and Other Records.

## How it fits together

| Piece | What it is |
|---|---|
| `public/` | The staff pages. `harbour-data.js` loads the data from the API. |
| `server.js`, `src/` | Node/Express server. Serves the pages and `/api/*`, and checks who is signed in and their role. |
| Azure SQL `harbour` database | `bms.*`: the tables copied from Access, same names. `app.*`: audit log, member accounts and change requests. `meta.Tables`: column definitions. |
| App Service Authentication | Handles Entra ID sign-in. Harbour only lets in people on its Operators list (`app.StaffUsers`). |
| `infra/main.bicep` | All Azure resources. |

There are no database passwords anywhere. The web app connects with its managed identity, and the scripts connect as whoever is signed in to the Azure CLI. `Staff.Password` from Access is never copied.

**Roles.** Admins manage these in Harbour under **Maintenance → Operators**:
- **Viewer**: view the database.
- **Approver**: view, and approve or reject changes members propose (phase 3).
- **Admin**: everything, plus invite operators, change roles and turn off access.

**Invites.** An Admin enters an email address and role. People outside the organisation get an invitation email from Microsoft (sent through Microsoft Graph by the web app's managed identity, which has only `User.Invite.All` and `User.Read.All`). People already in the tenant get a link to share. Access starts at their first sign-in and the invite expires after 14 days. Harbour can't remove the person from the tenant; turning off access only blocks Harbour.

**MFA.** Every staff sign-in records whether it used MFA, shown in the MFA column on the Operators page. Entra can only be made to require MFA by tenant policy: Security Defaults (free) or Conditional Access (Entra ID P1). Once that is on, set `REQUIRE_STAFF_MFA=true` (Bicep parameter `requireStaffMfa`), and Harbour will refuse any session without MFA.

## Run locally

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:8765>. Without settings it reads `data/BMSData.accdb` on the server side, as a local user with every role. To use Azure SQL instead, run `az login`, add your IP to the SQL server firewall, and set `SQL_SERVER` and `SQL_DATABASE` before `npm run dev`.

## Azure

First-time setup (re-runnable) deploys the infrastructure, creates the sign-in app registration, copies `data/BMSData.accdb` into Azure SQL and deploys the app:

```sh
az login
./scripts/azure-setup.sh
```

Day to day:

```sh
./scripts/deploy.sh                               # deploy code changes
curl https://ngatikuri-harbour-mmwucc.azurewebsites.net/healthz/db  # app can reach the database
SQL_SERVER=… SQL_DATABASE=harbour npm run migrate # re-copy BMSData.accdb (replaces bms.* tables; app.* is kept)
```

Re-running the migration replaces all `bms` tables with the contents of the Access file. Once staff or members start editing data in Azure, stop re-running it, because it would overwrite those edits.

## Roadmap

1. ✅ Azure SQL + App Service, data migrated, staff sign-in.
2. Member self-service: members sign in with Microsoft Entra External ID, staff link each account to an Applicant, members propose changes to their own record (`app.ChangeRequests`), and Approvers approve or reject them.
3. Attachments: upload the files that `Attachments.AttachmentAddress` points to (currently local `S:\` paths) into Azure Blob Storage.
