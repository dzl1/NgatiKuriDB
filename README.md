# Harbour — local Access database viewer

Harbour reads the bundled `data/BMSData.accdb` file directly in the browser. The database does not leave your computer. The Access reader and its small browser dependencies load from esm.sh, so the first page load needs an internet connection. Database parsing and CSV export happen in the browser.

## Run locally

Python 3 is required. From this folder, run:

```sh
npm run dev
```

Open <http://127.0.0.1:8765>. Keep the terminal open while using the app. No `npm install` or `mdbtools` installation is needed. Replace `data/BMSData.accdb` with the database you want to browse, keeping that filename, then refresh the page.

The viewer displays tables and their fields, previews records in pages, and exports all records or selected fields to CSV. Excel and Numbers can open the downloaded CSV files. The `.accde` file is a compiled Access application; the viewer reads the `.accdb` data file.

Use the **Access-style view** link or open <http://127.0.0.1:8765/access.html> for a second page with a Microsoft Access-inspired ribbon, navigation pane, object tabs, and datasheet grid. It is a read-only browser view of tables, not Microsoft Access itself; Access forms, reports, and query designer views are not rendered.

Open <http://127.0.0.1:8765/relationships.html> to review saved Access relationships and suggested joins inferred from field names and matching values. Suggested joins are for review and are not written back into the Access file.

Open <http://127.0.0.1:8765/users.html> for a person-centered view. Choose the table and key field that identify people, then select a person to see records in other tables that match their key. It combines direct matching links; indirect multi-table paths may need review in the relationship map.
