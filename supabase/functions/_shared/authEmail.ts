export interface AuthEmailEvent {
  user: { id: string; email: string; new_email?: string };
  email_data: { email_action_type: string; token_hash?: string; token_hash_new?: string; token?: string; redirect_to?: string; old_email?: string };
}
export interface DeletionProfile { room_deletion_requested_at: string | null; room_purge_after: string | null }
export interface AuthMail { to: string; subject: string; text: string; html: string }
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function mailbox(value: string | undefined): string {
  if (!value || value.length > 254 || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value)) throw new Error('invalid_recipient');
  return value;
}

function httpsBase(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hostname === 'localhost') throw new Error('invalid_base_url');
  return url;
}

function mail(to: string, subject: string, paragraphs: string[], link?: { url: string; title: string }): AuthMail {
  const text = [...paragraphs, ...(link ? [`${link.title}: ${link.url}`] : [])].join('\n\n');
  // Mail clients can drop inherited body colors. Pair explicit colors on content
  // with bgcolor and inline backgrounds on the enclosing table cells.
  const button = link ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin-top:24px"><tr><td bgcolor="#d5ad65" style="background-color:#d5ad65;border-radius:8px"><a style="display:inline-block;padding:12px 18px;color:#251b0c;font:600 15px/1.4 Arial,sans-serif;text-decoration:none" href="${escapeHtml(link.url)}">${escapeHtml(link.title)}</a></td></tr></table>` : '';
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f7f3eb;color:#302a22">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f7f3eb" style="background-color:#f7f3eb"><tr><td align="center" style="padding:20px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px">
<tr><td style="padding:0 4px 16px;color:#302a22;font:24px Georgia,serif">StaySee <span style="color:#795c2c">AI</span></td></tr>
<tr><td bgcolor="#ffffff" style="background-color:#ffffff;color:#302a22;border:1px solid #e1d7c6;border-top:2px solid #b6975b;border-radius:14px;padding:24px;text-align:left">
<h1 style="margin:0 0 16px;color:#302a22;font:normal 26px/1.25 Georgia,serif">${escapeHtml(subject.replace(/ — StaySee AI$/, ''))}</h1>
${paragraphs.map(p => `<p style="margin:0 0 14px;color:#302a22;font:16px/1.6 Arial,sans-serif">${escapeHtml(p)}</p>`).join('')}
${button}
</td></tr>
<tr><td style="padding:16px 4px 0;color:#625849;font:14px/1.5 Georgia,serif">Здесь можно побыть собой.</td></tr>
</table></td></tr></table></body></html>`;
  return { to: mailbox(to), subject, text, html };
}

/** Pure policy: user identity comes only from the verified hook, deletion state only from profiles. */
export function buildAuthEmails(event: AuthEmailEvent, profile: DeletionProfile | null, options: { authUrl: string; siteUrl: string }): AuthMail[] {
  const auth = httpsBase(options.authUrl);
  const site = httpsBase(options.siteUrl);
  const to = mailbox(event.user.email);
  const action = event.email_data.email_action_type;
  const securityNotifications: Record<string, string> = {
    password_changed_notification: 'Пароль для твоей комнаты StaySee AI изменён.',
    email_changed_notification: 'Адрес почты для твоей комнаты StaySee AI изменён.',
    phone_changed_notification: 'Номер телефона для твоей комнаты StaySee AI изменён.',
    identity_linked_notification: 'К твоей комнате StaySee AI подключён новый способ входа.',
    identity_unlinked_notification: 'От твоей комнаты StaySee AI отключён способ входа.',
    mfa_factor_enrolled_notification: 'Для твоей комнаты StaySee AI добавлен дополнительный способ подтверждения входа.',
    mfa_factor_unenrolled_notification: 'Для твоей комнаты StaySee AI удалён дополнительный способ подтверждения входа.',
  };
  if (Object.hasOwn(securityNotifications, action)) {
    // Supabase has already changed user.email. The warning belongs to the previous mailbox owner.
    const recipient = action === 'email_changed_notification' ? mailbox(event.email_data.old_email) : to;
    return [mail(recipient, 'Изменение настроек безопасности — StaySee AI', [securityNotifications[action], 'Если это был не ты, обратись в поддержку: support.stayseeai@gmail.com.'])];
  }
  if (profile?.room_deletion_requested_at) {
    const date = profile.room_purge_after ? new Date(profile.room_purge_after) : null;
    const day = date && !Number.isNaN(date.getTime())
      ? date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }).replace(/\s*г\.$/, '')
      : null;
    return [mail(to, 'Твоя комната удалена — StaySee AI', [
      'Ты запросил письмо для входа в StaySee AI, но комната на этот адрес уже удалена.',
      'Беседы, записки и память удалены. Восстановить комнату и её содержимое нельзя. Менять пароль не нужно.',
      day ? `Новую комнату на этот email можно будет создать с ${day.trim()}.` : 'Запись для входа временно хранится до назначенного при удалении срока. Точную дату можно уточнить в поддержке.',
      'Запись для входа будет удалена автоматически. Если ты не запрашивал это письмо, ничего делать не нужно.',
    ], { url: site.origin, title: 'Открыть StaySee AI' })];
  }
  // Never trust arbitrary redirect_to: a signed event may carry a caller-controlled redirect.
  const link = (hash: string | undefined, type = action) => {
    if (!hash) throw new Error('missing_token_hash');
    const url = new URL(`${auth.pathname.replace(/\/$/, '')}/auth/v1/verify`, auth.origin);
    url.searchParams.set('token', hash);
    url.searchParams.set('type', type);
    url.searchParams.set('redirect_to', `${site.origin}/`);
    return url.href;
  };
  if (action === 'email_change') {
    const next = mailbox(event.user.new_email);
    const make = (recipient: string, hash: string | undefined) => mail(recipient, 'Подтверждение смены почты — StaySee AI', [
      'Ты запросил смену адреса почты для комнаты StaySee AI. Подтверди изменение по ссылке.',
      'Если это был не ты, не подтверждай изменение и обратись в поддержку.',
    ], { url: link(hash), title: 'Подтвердить смену почты' });
    return [...(event.email_data.token_hash_new ? [make(to, event.email_data.token_hash_new)] : []), make(next, event.email_data.token_hash)];
  }
  if (action === 'reauthentication') {
    if (!event.email_data.token || !/^\d{6,10}$/.test(event.email_data.token)) throw new Error('invalid_otp');
    return [mail(to, 'Код подтверждения — StaySee AI', [`Код для подтверждения действия: ${event.email_data.token}`, 'Никому не сообщай этот код. Если это был не ты, ничего не подтверждай.'])];
  }
  const copy: Record<string, [string, string, string]> = {
    signup: ['Подтверди почту для твоей комнаты — StaySee AI', 'Подтверди адрес почты, чтобы открыть свою комнату StaySee AI.', 'Подтвердить почту'],
    recovery: ['Новый пароль для твоей комнаты — StaySee AI', 'Ты запросил новый пароль для своей комнаты StaySee AI. По ссылке можно задать его заново.', 'Задать новый пароль'],
    magiclink: ['Вход в твою комнату — StaySee AI', 'Ты запросил ссылку для входа в свою комнату StaySee AI.', 'Войти в комнату'],
    invite: ['Приглашение в StaySee AI', 'Тебя пригласили открыть комнату StaySee AI.', 'Принять приглашение'],
  };
  const entry = copy[action];
  if (!entry) throw new Error('unsupported_email_action');
  return [mail(to, entry[0], [entry[1], 'Ссылка действует ограниченное время и только один раз. Если это был не ты, просто проигнорируй письмо.'], { url: link(event.email_data.token_hash), title: entry[2] })];
}
