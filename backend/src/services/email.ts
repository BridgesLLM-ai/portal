import nodemailer from 'nodemailer';
import { prisma } from '../config/database';

type SendEmailInput = {
  to: string;
  subject: string;
  html?: string;
  text?: string;
};

type EmailConfig = {
  configured: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromName: string;
  fromEmail: string;
};

async function loadSmtpSettings(): Promise<EmailConfig> {
  const keys = [
    'smtp.host',
    'smtp.port',
    'smtp.secure',
    'smtp.user',
    'smtp.password',
    'smtp.fromName',
    'smtp.fromEmail',
  ];

  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: keys } },
  });

  const map: Record<string, string> = {};
  for (const row of rows) map[row.key] = row.value;

  const host = map['smtp.host'] || '';
  const port = Number.parseInt(map['smtp.port'] || '587', 10) || 587;
  const secure = map['smtp.secure'] === 'true';
  const user = map['smtp.user'] || '';
  const password = map['smtp.password'] || '';
  const fromName = map['smtp.fromName'] || 'Bridges Portal';
  const fromEmail = map['smtp.fromEmail'] || user || '';

  const configured = Boolean(host && port && user && password && fromEmail);

  return {
    configured,
    host,
    port,
    secure,
    user,
    password,
    fromName,
    fromEmail,
  };
}

export async function getEmailConfig() {
  const cfg = await loadSmtpSettings();
  return {
    configured: cfg.configured,
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    fromName: cfg.fromName,
    fromEmail: cfg.fromEmail,
  };
}

export async function sendEmail({ to, subject, html, text }: SendEmailInput): Promise<void> {
  const cfg = await loadSmtpSettings();

  if (!cfg.configured) {
    throw new Error('SMTP is not fully configured');
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: {
      user: cfg.user,
      pass: cfg.password,
    },
  });

  await transporter.sendMail({
    from: cfg.fromName ? `"${cfg.fromName}" <${cfg.fromEmail}>` : cfg.fromEmail,
    to,
    subject,
    text: text || ' ',
    html: html || text || ' ',
  });
}

export async function sendTestEmail(adminEmail: string): Promise<void> {
  const now = new Date();
  const iso = now.toISOString();

  await sendEmail({
    to: adminEmail,
    subject: 'Bridges Portal SMTP test email',
    text: `SMTP test successful.\n\nSent at: ${iso}`,
    html: `<p><strong>SMTP test successful.</strong></p><p>Sent at: ${iso}</p>`,
  });
}


async function getAdminEmails(): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: { role: { in: ['OWNER', 'SUB_ADMIN'] as any }, isActive: true, accountStatus: 'ACTIVE' } as any,
    select: { email: true },
  });
  return [...new Set(admins.map((a) => a.email).filter(Boolean))];
}

async function isNotificationEnabled(key: string): Promise<boolean> {
  const setting = await prisma.systemSetting.findUnique({ where: { key } });
  return setting?.value !== 'false';
}

export async function sendJobFailedAlert(userId: string, jobTitle: string, toolId: string, error: string): Promise<void> {
  const notify = await isNotificationEnabled('notifications.systemAlerts');
  if (!notify) return;

  const recipients = await getAdminEmails();
  if (!recipients.length) return;

  await Promise.all(recipients.map((to) => sendEmail({
    to,
    subject: `Agent job failed: ${jobTitle || toolId}`,
    text: [
      'An agent job exited with an error.',
      `User ID: ${userId}`,
      `Job Title: ${jobTitle || '(untitled)'}`,
      `Tool: ${toolId}`,
      `Error: ${error}`,
    ].join('\n'),
    html: `
      <p><strong>An agent job exited with an error.</strong></p>
      <ul>
        <li><strong>User ID:</strong> ${userId}</li>
        <li><strong>Job Title:</strong> ${jobTitle || '(untitled)'}</li>
        <li><strong>Tool:</strong> ${toolId}</li>
        <li><strong>Error:</strong> ${error}</li>
      </ul>
    `,
  })));
}

export async function sendDiskAlert(percentUsed: number): Promise<void> {
  const notify = await isNotificationEnabled('notifications.systemAlerts');
  if (!notify) return;

  const recipients = await getAdminEmails();
  if (!recipients.length) return;

  await Promise.all(recipients.map((to) => sendEmail({
    to,
    subject: `Disk usage alert: ${percentUsed.toFixed(1)}% used`,
    text: `Disk usage has exceeded threshold. Current usage: ${percentUsed.toFixed(1)}%`,
    html: `<p><strong>Disk usage alert:</strong> ${percentUsed.toFixed(1)}% used</p>`,
  })));
}

export async function sendNewUserAlert(email: string, username: string): Promise<void> {
  const notify = await isNotificationEnabled('notifications.newRegistration');
  if (!notify) return;

  const recipients = await getAdminEmails();
  if (!recipients.length) return;

  await Promise.all(recipients.map((to) => sendEmail({
    to,
    subject: 'New user registration request',
    text: `A new user registration request was submitted.\n\nEmail: ${email}\nUsername/Name: ${username}`,
    html: `<p><strong>New user registration request submitted.</strong></p><p>Email: ${email}<br/>Username/Name: ${username}</p>`,
  })));
}
