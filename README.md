# ESAFN — Emergency Services Aviation Fuel Network

Shared fuel installation record for Gama Aviation operated bowsers.

## What it does

- Records aircraft refuels, rebulks (replenishments) and FRM-GO-402 fuel installation checks
- Single shared bowser level across all devices — no per-device copies
- Alerts below 1,000 L with a pre-filled text message
- Prints the monthly FRM-GO-402 (31 daily + 10 rebulk lines) plus a reconciliation
  ledger for cross-checking against accounts, receipts and refuel confirmations

## Layout

    public/index.html            the app (single file)
    netlify/functions/api.mjs    shared state API, backed by Netlify Blobs
    netlify.toml                 build and header config

## Configuration

Set these as environment variables in the Netlify dashboard
(Site configuration → Environment variables):

| Variable           | Purpose                                    | Format |
|--------------------|--------------------------------------------|--------|
| `ESAFN_CODES`      | Unit access codes                          | `CODE:UNIT:BASEID,…` — base ID blank for no home base |
| `ESAFN_ADMIN_CODE` | Code required to reset test data           | any string |
| `ESAFN_SITES`      | Override the site list (optional)           | JSON array of site objects |

## Notes

- Fuel data lives in Netlify Blobs and **survives redeploys**. Reset before live use.
- Records cannot be edited or deleted individually — by design, for audit purposes.
- Access codes are currently 4 digits. Lengthen `ESAFN_CODES` before this holds
  records that back invoicing (needs the login field widened to match).
