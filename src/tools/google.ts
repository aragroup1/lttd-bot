import { google } from "googleapis";
import { config, rsvpSign } from "../config.js";

const credentials = JSON.parse(config.googleServiceAccountJson);

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
  ],
});

const drive = google.drive({ version: "v3", auth });
const sheets = google.sheets({ version: "v4", auth });

function sheetName(color: string, slug: string): string {
  return `lttd-${color}-${slug}-rsvp`;
}

async function findSheetByName(name: string): Promise<string | null> {
  const res = await drive.files.list({
    q: `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: "files(id, name)",
    pageSize: 1,
  });
  return res.data.files?.[0]?.id ?? null;
}

export async function ensureRsvpSheet(
  color: string,
  slug: string
): Promise<{ sheetId: string; sheetUrl: string; name: string; sig: string }> {
  const name = sheetName(color, slug);
  let sheetId = await findSheetByName(name);

  if (!sheetId) {
    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.spreadsheet",
      },
      fields: "id",
    });
    sheetId = created.data.id!;

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: "A1:G1",
      valueInputOption: "RAW",
      requestBody: {
        values: [["Timestamp", "Name", "Attending", "Guests", "Dietary", "Message", "Raw"]],
      },
    });

    await drive.permissions.create({
      fileId: sheetId,
      requestBody: { role: "reader", type: "anyone" },
    });
  }

  return {
    sheetId,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
    name,
    sig: rsvpSign(slug, sheetId),
  };
}

const KNOWN_FIELDS = ["name", "attending", "guests", "dietary", "message"];

export async function appendRsvpRow(
  sheetId: string,
  body: Record<string, unknown>
): Promise<void> {
  const row: (string | number)[] = [new Date().toISOString()];
  for (const key of KNOWN_FIELDS) {
    const v = body[key];
    row.push(v == null ? "" : String(v));
  }
  row.push(JSON.stringify(body));

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: "A:G",
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
}

export async function deleteRsvpSheet(color: string, slug: string): Promise<{ deleted: boolean }> {
  const name = sheetName(color, slug);
  const sheetId = await findSheetByName(name);
  if (!sheetId) return { deleted: false };
  await drive.files.delete({ fileId: sheetId });
  return { deleted: true };
}
