import { createClient } from 'npm:@supabase/supabase-js@2.107.0';
import nodemailer from 'npm:nodemailer@10.3.1';
import { createConnection, type Socket } from 'node:net';
import { Webhook } from 'npm:standardwebhooks@1.1.1';
import { createAuthEmailHandler } from '../_shared/authEmailHandler.ts';

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}

// Existing SMTP stays active until this function is ready AND the hook is enabled.
const authUrl = required('SUPABASE_URL');
const service = createClient(authUrl, required('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const webhook = new Webhook(required('SEND_EMAIL_HOOK_SECRET').replace(/^v1,whsec_/, ''));
const smtpOptions = {
  host: 'postbox.cloud.yandex.net', port: 587, secure: false, requireTLS: true,
  auth: { user: required('POSTBOX_SMTP_USER'), pass: required('POSTBOX_SMTP_PASSWORD') },
  connectionTimeout: 2500, greetingTimeout: 2500, socketTimeout: 3500,
  tls: { minVersion: 'TLSv1.2' as const, rejectUnauthorized: true },
};

Deno.serve(createAuthEmailHandler({
  authUrl,
  siteUrl: 'https://staysee.ru',
  verify: (payload, headers) => webhook.verify(payload, Object.fromEntries(headers)),
  lookupProfile: async (userId, signal) => {
    const { data, error } = await service.from('profiles')
      .select('room_deletion_requested_at,room_purge_after').eq('id', userId).abortSignal(signal).maybeSingle();
    if (error) throw new Error('profile_lookup_failed');
    return data;
  },
  send: async (mail, signal) => {
    signal.throwIfAborted();
    // Separate transporter per message: cancelling one hook must not close another user's connection.
    // SMTPTransport.close() alone does NOT close an in-flight socket. Keep the actual TCP socket to cancel TLS too.
    let socket: Socket | undefined;
    const cancel = () => { socket?.destroy(); };
    const transport = nodemailer.createTransport({ ...smtpOptions, getSocket: (_options, callback) => {
      if (signal.aborted) { callback(new Error('mail_cancelled'), false); return; }
      let returned = false;
      socket = createConnection({ host: smtpOptions.host, port: smtpOptions.port });
      const finish = (error: Error | null) => {
        if (returned) return;
        returned = true;
        callback(error, error ? false : { connection: socket! });
      };
      socket.once('connect', () => finish(null));
      socket.once('error', error => finish(error));
      socket.once('close', () => finish(new Error('mail_connection_closed')));
    } });
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await transport.sendMail({ from: '"StaySee AI" <no-reply@staysee.ru>', ...mail });
      signal.throwIfAborted();
      if (!result.accepted?.length || result.rejected?.length) throw new Error('mail_not_accepted');
    } finally {
      signal.removeEventListener('abort', cancel);
      socket?.destroy();
      transport.close();
    }
  },
}));
