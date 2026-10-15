// Double Marvellous — health check enquiry form → Brevo (email to Barry + contact on a list).
// Netlify env vars: BREVO_API_KEY (required), BREVO_LIST_ID (optional, a number).

const TO_EMAIL = 'info@doublemarvellous.com';
const TO_NAME = 'Barry English';
const SENDER_EMAIL = 'info@doublemarvellous.com'; // must be a verified sender in Brevo
const SENDER_NAME = 'Website Health Check';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export default async (req) => {
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return json({ ok: false, error: 'Mail is not configured' }, 500);

  let d;
  try { d = await req.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
  const get = (k, max = 500) => String(d?.[k] ?? '').trim().slice(0, max);

  if (get('company_site')) return json({ ok: true }); // honeypot

  const name = get('name', 100), email = get('email', 255), phone = get('phone', 40);
  const site = get('site', 300), message = get('message', 2000);
  const summary = get('summary', 1500), grade = get('grade', 2);
  if (!name) return json({ ok: false, error: 'Please enter your name.' }, 422);
  if (!isEmail(email)) return json({ ok: false, error: 'Please enter a valid email.' }, 422);
  if (!get('consent')) return json({ ok: false, error: 'Please tick the consent box.' }, 422);

  const fields = { Name: name, Email: email, Phone: phone || '–', Website: site, Grade: grade || '–', Message: message || '–', 'Report summary': summary || '–' };
  const subject = `Health check enquiry – ${site || name}${grade ? ` (grade ${grade})` : ''}`;
  const rows = Object.entries(fields).map(([k, v]) =>
    `<tr><td style="padding:6px 12px 6px 0;vertical-align:top;font-weight:600">${esc(k)}</td><td style="padding:6px 0">${esc(v).replace(/\n/g, '<br>')}</td></tr>`).join('');

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({
      sender: { email: SENDER_EMAIL, name: SENDER_NAME },
      to: [{ email: TO_EMAIL, name: TO_NAME }],
      replyTo: { email, name },
      subject,
      htmlContent: `<html><body style="font-family:sans-serif"><h2>${esc(subject)}</h2><table>${rows}</table></body></html>`,
      textContent: Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n'),
      tags: ['health-check'],
    }),
  });
  if (!res.ok) {
    console.error('Brevo send failed', res.status, await res.text());
    return json({ ok: false, error: 'Sorry, something went wrong. Please try again.' }, 502);
  }

  const listId = parseInt(process.env.BREVO_LIST_ID || '', 10);
  if (listId) {
    try {
      const c = await fetch('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify({ email, attributes: { FIRSTNAME: name }, listIds: [listId], updateEnabled: true }),
      });
      if (!c.ok) console.error('Brevo contact failed', c.status, await c.text());
    } catch (err) { console.error('Brevo contact error', err); }
  }
  return json({ ok: true });
};

export const config = { path: '/api/lead' };
