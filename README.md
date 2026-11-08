# Harbour — Ngāti Kuri database entries

Harbour is a local, read-only browser for the beneficiary management database. Start it from this folder with:

```sh
npm run dev
```

In Windows PowerShell, use `npm.cmd run dev` if the execution policy blocks `npm.ps1`. Open <http://127.0.0.1:8765>. Keep the terminal open while using the app. No `npm install` is needed.

The app opens at **Database Entries → List All**, sorted by last name, then first name. Use the name control to switch between A–Z and Z–A, or choose **List by DOB** to sort earliest to latest using the date-of-birth field. DOB values display as `M/D/YYYY`, matching the Access screen (for example, `9/20/1935`). **Export all users** downloads a CSV with one row per person, their main fields, and linked records in numbered table-field columns. Applicant Status IDs are accompanied by their lookup labels in the profile and export. Select a person to see their main Contact Details and related Attachments, Emails, All Notes, Funding Applications, and Other Records. The table and key selectors remain available for choosing the database table that contains people and its linking field.

The viewer reads `data/BMSData.accdb` directly in the browser. The database stays on this device. The Access reader and its small browser dependencies load from esm.sh, so the first page load needs an internet connection. Replace `data/BMSData.accdb` with the database you want to browse, keeping that filename, then refresh the page.
