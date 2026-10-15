# WordPress Health Check (Double Marvellous)

Static page + two Netlify functions:

- `netlify/functions/check.mjs` → `/api/check` fetches a site's homepage and returns the scored report.
- `netlify/functions/lead.mjs` → `/api/lead` sends the enquiry form to Brevo.

## Deploy
1. Push this folder to its own GitHub repo and add it as a new Netlify site (no build command).
2. In Netlify → Site configuration → Environment variables, add:
   - `BREVO_API_KEY` — your Brevo API key
   - `BREVO_LIST_ID` — optional, the Brevo list number to add leads to
3. Optional: point a subdomain at it, e.g. `check.doublemarvellous.com`.

`info@doublemarvellous.com` must be a verified sender in Brevo (it already is if Freelance Ireland's form works).

## Sharing
`/?url=example.ie` runs the check automatically, so you can link straight to a report.

## Notes
- Only public addresses are fetched; internal/private IPs are refused.
- No rate limiting. If it gets abused, add Netlify's rate limiting or a simple captcha.
