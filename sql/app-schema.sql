-- Tables Harbour itself owns (not copied from Access). Safe to run repeatedly: the migration
-- runs this every time and it never drops or changes existing rows.

IF SCHEMA_ID('bms') IS NULL EXEC('CREATE SCHEMA bms');   -- tables migrated from BMSData.accdb
IF SCHEMA_ID('meta') IS NULL EXEC('CREATE SCHEMA meta'); -- migration metadata
IF SCHEMA_ID('app') IS NULL EXEC('CREATE SCHEMA app');   -- Harbour's own data

IF OBJECT_ID('meta.Tables') IS NULL
CREATE TABLE meta.Tables (
  Name         NVARCHAR(128) NOT NULL PRIMARY KEY,
  IsSystem     BIT           NOT NULL,
  ColumnsJson  NVARCHAR(MAX) NOT NULL, -- column definitions as mdb-reader reports them
  [RowCount]   INT           NOT NULL,
  MigratedAt   DATETIME2(0)  NOT NULL
);

IF OBJECT_ID('app.AuditLog') IS NULL
CREATE TABLE app.AuditLog (
  AuditLogId   BIGINT IDENTITY PRIMARY KEY,
  At           DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),
  ActorId      NVARCHAR(100) NULL,
  ActorName    NVARCHAR(200) NULL,
  Action       NVARCHAR(100) NOT NULL,
  TableName    NVARCHAR(128) NULL,
  RecordKey    NVARCHAR(100) NULL,
  DetailsJson  NVARCHAR(MAX) NULL
);

-- Who may use the staff app, and with which role. Admins invite people from the Staff page;
-- the invite is tied to the person's Entra object id and becomes active on their first sign-in.
--   Viewer:   view the database
--   Approver: view + approve/reject member change requests
--   Admin:    everything + invite and manage staff
IF OBJECT_ID('app.StaffUsers') IS NULL
CREATE TABLE app.StaffUsers (
  StaffUserId      INT IDENTITY PRIMARY KEY,
  Email            NVARCHAR(320) NOT NULL,
  DisplayName      NVARCHAR(200) NULL,
  Role             NVARCHAR(20)  NOT NULL CHECK (Role IN ('Viewer', 'Approver', 'Admin')),
  Status           NVARCHAR(20)  NOT NULL DEFAULT 'invited' CHECK (Status IN ('invited', 'active', 'disabled')),
  EntraObjectId    NVARCHAR(100) NULL,
  InvitedBy        NVARCHAR(200) NULL,
  InvitedAt        DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),
  InviteExpiresAt  DATETIME2(0)  NULL,
  ActivatedAt      DATETIME2(0)  NULL,
  LastSignInAt     DATETIME2(0)  NULL,
  LastSignInMfa    BIT           NULL
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_StaffUsers_Email')
CREATE UNIQUE INDEX UX_StaffUsers_Email ON app.StaffUsers (Email);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_StaffUsers_EntraObjectId')
CREATE UNIQUE INDEX UX_StaffUsers_EntraObjectId ON app.StaffUsers (EntraObjectId) WHERE EntraObjectId IS NOT NULL;

-- Phase 3: member self-service.
-- A member's login (Entra External ID) is linked by staff to one Applicants.ApplicantID.
IF OBJECT_ID('app.MemberAccounts') IS NULL
CREATE TABLE app.MemberAccounts (
  MemberAccountId  INT IDENTITY PRIMARY KEY,
  ExternalUserId   NVARCHAR(100) NOT NULL UNIQUE, -- object id from External ID
  Email            NVARCHAR(320) NULL,
  ApplicantID      INT           NULL,            -- NULL until staff confirm who they are
  Status           NVARCHAR(20)  NOT NULL DEFAULT 'pending' CHECK (Status IN ('pending', 'linked', 'disabled')),
  CreatedAt        DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),
  LinkedBy         NVARCHAR(200) NULL,
  LinkedAt         DATETIME2(0)  NULL
);

-- Members propose changes to their own record; staff with the Approver role approve or reject.
-- Nothing in bms.Applicants changes until a request is approved.
IF OBJECT_ID('app.ChangeRequests') IS NULL
CREATE TABLE app.ChangeRequests (
  ChangeRequestId  INT IDENTITY PRIMARY KEY,
  ApplicantID      INT           NOT NULL,
  MemberAccountId  INT           NOT NULL REFERENCES app.MemberAccounts (MemberAccountId),
  ChangesJson      NVARCHAR(MAX) NOT NULL, -- { "Field": { "from": ..., "to": ... }, ... }
  MemberNote       NVARCHAR(1000) NULL,
  Status           NVARCHAR(20)  NOT NULL DEFAULT 'pending' CHECK (Status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  SubmittedAt      DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),
  ReviewedBy       NVARCHAR(200) NULL,
  ReviewedAt       DATETIME2(0)  NULL,
  ReviewNote       NVARCHAR(1000) NULL
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ChangeRequests_Status')
CREATE INDEX IX_ChangeRequests_Status ON app.ChangeRequests (Status, SubmittedAt);

-- What a member tells us when they register, so staff can find their existing record
-- (link) or add them to the register (create). A member may resubmit after a rejection.
IF OBJECT_ID('app.MemberRegistrations') IS NULL
CREATE TABLE app.MemberRegistrations (
  RegistrationId   INT IDENTITY PRIMARY KEY,
  MemberAccountId  INT           NOT NULL REFERENCES app.MemberAccounts (MemberAccountId),
  DetailsJson      NVARCHAR(MAX) NOT NULL,
  Status           NVARCHAR(20)  NOT NULL DEFAULT 'pending' CHECK (Status IN ('pending', 'linked', 'created', 'rejected')),
  SubmittedAt      DATETIME2(0)  NOT NULL DEFAULT SYSUTCDATETIME(),
  ApplicantID      INT           NULL,
  ReviewedBy       NVARCHAR(200) NULL,
  ReviewedAt       DATETIME2(0)  NULL,
  ReviewNote       NVARCHAR(1000) NULL
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_MemberRegistrations_Status')
CREATE INDEX IX_MemberRegistrations_Status ON app.MemberRegistrations (Status, SubmittedAt);

-- One linked member account per applicant.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_MemberAccounts_ApplicantID')
CREATE UNIQUE INDEX UX_MemberAccounts_ApplicantID ON app.MemberAccounts (ApplicantID) WHERE ApplicantID IS NOT NULL AND Status = 'linked';
