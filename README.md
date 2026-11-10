# Harbour — Ngāti Kuri Iwi Register

Harbour is the Ngāti Kuri iwi register online. It has three parts:

- **Home page** (`/`): public information about the register. Anyone can open it, but it is hidden from search engines and AI crawlers.
- **Member portal** (`/member.html`): uri register, then see their record and ask for changes. Members sign in with **Microsoft Entra External ID**.
- **Staff app** (`/users.html` and the rest): the beneficiary database. Staff sign in with their Microsoft Entra ID work account.

The data lives in **Azure SQL in New Zealand North**.

The staff app opens at **Applications → List All**, showing everyone on the register sorted by last name, then first name. Use the name control to switch between A–Z and Z–A.

**Applications** also lists each phase with a count. Each phase shows people with one status:

| Phase | Status shown |
|---|---|
| Processing | Application Received (10) |
| Awaiting Information | Further Information requested (20) |
| Registered | Registered Whanau Member (30) |
| Declined | Application Rejected (40) |
| Cancelled | Application Cancelled (99) |

Approvers and Admins move a person between phases with **Move to…** on their record. This adds a dated line to Notes ("Application Received → Registered Whanau Member by …"), sets ApprovedDate when registering and RejectedDate when declining, and is audited. People with other statuses appear only in List All. `users.html?view=processing` (or `awaiting`, `registered`, `declined`, `cancelled`) opens a phase directly. **Applications → Add person** adds someone by hand, for example from a paper form. DOB values display as `M/D/YYYY`, matching the Access screen (for example, `9/20/1935`). **Export all users** downloads a CSV with one row per person, their main fields, and linked records in numbered table-field columns. Applicant Status IDs are accompanied by their lookup labels in the profile and export. Select a person to see their main Contact Details and related Attachments, Emails, All Notes, Funding Applications, and Other Records.

## How it fits together

| Piece | What it is |
|---|---|
| `www/` | Public pages: home page, member portal, logo, self-hosted Inter font. |
| `public/` | Staff pages. `harbour-data.js` loads the data from the API. |
| `server.js`, `src/` | Node/Express server. Serves the pages and `/api/*`, and checks who is signed in and their role. `src/members.js` holds member registration and approvals. |
| Azure SQL `harbour` database | `bms.*`: the register, tables copied from Access with the same names. `app.*`: operators, member accounts, registrations, change requests and the audit log. `meta.Tables`: column definitions. |
| App Service Authentication | Two sign-in providers. `aad` is staff, using the organisation's Entra ID tenant. `members` is members, using the External ID tenant `ngatikurimembers`. A member sign-in can never act as staff. |
| Key Vault | Holds the member sign-in client secret. The web app reads it with its managed identity. |
| `infra/main.bicep` | All Azure resources. |

There are no database passwords anywhere. The web app connects with its managed identity, and the scripts connect as whoever is signed in to the Azure CLI. `Staff.Password` from Access is never copied.

## Staff

**Roles.** Admins manage these under **Maintenance → Operators**:
- **Viewer**: view the database.
- **Approver**: view, plus **Maintenance → Member requests** to deal with registrations and changes.
- **Admin**: everything, plus invite operators, change roles and turn off access.

**Invites.** An Admin enters an email address and role. People outside the organisation get an invitation email from Microsoft (sent through Microsoft Graph by the web app's managed identity, which has only `User.Invite.All` and `User.Read.All`). People already in the tenant get a link to share. Access starts at their first sign-in and the invite expires after 14 days.

**MFA.** Every staff sign-in records whether it used MFA (the MFA column on Operators). Entra can only be made to require MFA by tenant policy: Security Defaults (free) or Conditional Access (Entra ID P1). Once that is on, set `requireStaffMfa=true` in Bicep and Harbour will refuse any session without MFA.

## Members

1. A member chooses **Register or sign in** and creates an account with email and password. External ID checks the email address with a code.
2. On `/member.html` they fill in their details and whakapapa (parents, grandparents and tūpuna) and agree to how their information is used. This is saved to `app.MemberRegistrations`, not the register.
3. An Approver opens **Member requests**. Harbour suggests possible existing records (matching date of birth, similar-sounding names, email). The Approver then either:
   - **links** the member to an existing record,
   - **adds** them as a new applicant with status *Application Received*, or
   - **rejects** with a note the member sees, and the member can then correct and resend.
4. Once linked, the member sees their record and can **ask for changes** to their name, date of birth, gender, address, phone and email. Each request goes to `app.ChangeRequests`. An Approver approves it, which updates `bms.Applicants`, or rejects it with a note. Approval is refused if the record changed after the member asked, so a member never overwrites someone else's update.

Every registration, decision and change is in `app.AuditLog`.

**Member MFA** is a Conditional Access policy in the members tenant: password, then a one-time code sent by email. See *Finishing member sign-in* below.

## Run locally

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:8765>. Without settings it reads `data/BMSData.accdb` on the server side. Local sign-in is simulated:
- `/dev/as?who=staff` makes you a local Admin.
- `/dev/as?who=member` makes you a local member.
- `/dev/as?who=none` makes you an anonymous visitor.

Member features need Azure SQL: run `az login`, add your IP to the SQL server firewall, and set `SQL_SERVER` and `SQL_DATABASE`. Use a copy of the database for testing, not `harbour`.

## Azure

First-time setup (re-runnable). It deploys the infrastructure, creates the staff sign-in app registration, copies `data/BMSData.accdb` into Azure SQL and deploys the app. Setting `MEMBER_TENANT_ID` also configures member sign-in:

```sh
az login
MEMBER_TENANT_ID=06b0c976-572b-4530-90fc-93197eabd7d5 ./scripts/azure-setup.sh
```

Day to day:

```sh
./scripts/deploy.sh                                   # deploy code changes
SQL_SERVER=… SQL_DATABASE=harbour node scripts/apply-schema.js   # after changing sql/app-schema.sql: create new Harbour tables (needs your IP in the SQL firewall)
curl https://ngatikuri-harbour-mmwucc.azurewebsites.net/healthz/db   # app can reach the database
node scripts/setup-member-signin.js <tenant> <url> <vault> --rotate-secret   # new member sign-in secret (restart the app after)
```

`npm run migrate` re-copies `BMSData.accdb` and **replaces** the register. It refuses to run once the register has been edited in Harbour (approved member changes or members added online), unless you add `--force`.

### Finishing member sign-in (portal, once)

The Azure CLI isn't allowed to change these settings, so make them in the [Entra admin centre](https://entra.microsoft.com). Switch to the **Ngati Kuri Members** tenant first.

1. **Overview → Properties → Manage security defaults → Disabled.** Conditional Access replaces it, so do steps 2–4 straight away.
2. **Authentication methods → Policies → Email OTP:** Enable, target All users.
3. **Conditional Access → New policy "Members must use MFA":** Users = All users. Target resources = *Ngati Kuri Member Portal*. Grant = Require multifactor authentication. On.
4. **Conditional Access → New policy "Admins must use MFA":** Users = Directory roles (Global Administrator and other admin roles). Target resources = All resources. Grant = Require MFA. On.
5. Optional: **Company branding.** Set the background colour to `#032306` and upload a logo with a dark background (the Ngāti Kuri logo is white).

## Roadmap

1. ✅ Azure SQL + App Service, data migrated, staff sign-in with invites and roles.
2. ✅ Public home page, member registration, member change requests with staff approval.
3. Email members when their registration or change is decided (for example with Azure Communication Services).
4. Attachments: upload the files that `Attachments.AttachmentAddress` points to (currently local `S:\` paths) into Azure Blob Storage.
