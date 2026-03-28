# Email System

Built-in email via Stalwart Mail Server (JMAP). Portal page: `/mail`.

## Architecture

```
Stalwart Mail Server (:8580 JMAP, :25 SMTP, :993 IMAP, :465 SMTPS)
  └── JMAP API → Portal backend → Mail UI
```

**Mail domain**: Configured via `MAIL_DOMAIN` env var (e.g., `bridgesllm.com`).

## Mail Accounts

Each portal user can have a personal mailbox. Admins also have access to:

- **Personal**: `<username>@<domain>` — user's own mailbox
- **Support**: `support@<domain>` — shared support inbox (admin only)
- **No-Reply**: `noreply@<domain>` — system notifications (admin only)

Credentials stored in Stalwart; portal accesses via JMAP with per-user auth.

## Backend API

All routes under `/api/mail/`, require authentication.

### Reading Email
- `GET /api/mail/accounts` — List accessible mail accounts
- `GET /api/mail/mailboxes` — List mailbox folders (Inbox, Sent, Trash, etc.)
- `GET /api/mail/unread` — Get unread count
- `GET /api/mail/messages?mailbox=<id>&limit=50&position=0` — List emails
- `GET /api/mail/messages/<id>` — Get single email (full body, attachments)
- `GET /api/mail/attachments/<blobId>` — Download attachment

### Sending Email
- `POST /api/mail/send` — Send email (multipart form with attachments)
  - Fields: `to`, `cc`, `bcc`, `subject`, `textBody`, `htmlBody`
  - Attachments: `attachments` (file upload, max 10 files, 25MB each)
- `POST /api/mail/forward` — Forward email with optional attachments

### Management
- `POST /api/mail/messages/<id>/trash` — Move to trash
- `POST /api/mail/messages/<id>/move` — Move to folder (`{mailboxId}`)
- `POST /api/mail/messages/<id>/flag` — Toggle star/flag
- `POST /api/mail/messages/<id>/read` — Mark as read/unread (`{read: true}`)
- `POST /api/mail/bulk/read` — Bulk mark read (`{messageIds, read}`)
- `POST /api/mail/bulk/trash` — Bulk trash (`{messageIds}`)
- `POST /api/mail/bulk/move` — Bulk move (`{messageIds, mailboxId}`)

### Settings
- `GET /api/mail/signature` — Get email signature
- `PUT /api/mail/signature` — Save email signature (`{signature}`)
- `GET /api/mail/forward-settings` — Get auto-forward config
- `PUT /api/mail/forward-settings` — Set auto-forward (`{enabled, forwardTo}`)
- `GET /api/mail/credentials` — Get IMAP/SMTP credentials for external clients

## Agent Email Access

To read/send email as the agent, use the portal API with admin auth or use the OpenClaw gateway's HTTP client to call the mail endpoints. The mail service uses JMAP internally — all operations go through `http://127.0.0.1:8580`.

### Reading inbox from CLI (direct JMAP)
```bash
# Get session
curl -su "username:password" http://127.0.0.1:8580/.well-known/jmap
# Then use the JMAP API URL from the session response
```

### Checking for new mail
The portal UI polls `GET /api/mail/unread` for badge counts. The agent can do the same.

## Email Configuration

Set in portal `.env.production`:
```
STALWART_URL=http://127.0.0.1:8580
STALWART_SUPPORT_USER=support
STALWART_SUPPORT_PASS=<password>
STALWART_NOREPLY_USER=noreply
STALWART_NOREPLY_PASS=<password>
MAIL_DOMAIN=bridgesllm.com
```

DNS records required: MX, SPF (TXT), DKIM (TXT), DMARC (TXT).

## Troubleshooting

- **401 from JMAP**: Check Stalwart credentials in `.env.production`
- **Can't send**: Verify DNS records (MX, SPF, DKIM). Check `journalctl -u stalwart-mail`
- **Attachments blocked**: Dangerous file types (.exe, .bat, etc.) are rejected
- **Virus scan**: Attachments scanned via ClamAV if available (non-blocking)
