const AUTH_REQUEST_TIMEOUT_MS = 25_000;

/** Reject if Supabase Auth does not respond (stuck spinner on forms). */
export function withAuthTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error('auth_timeout'));
    }, AUTH_REQUEST_TIMEOUT_MS);
    promise
      .then((value) => {
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        window.clearTimeout(timer);
        reject(err);
      });
  });
}

/** User-facing text for sign-up errors. */
export function mapSignUpError(message: string): string {
  const m = message.toLowerCase();

  if (message === 'auth_timeout') {
    return 'Сервер не ответил вовремя. Проверьте интернет и попробуйте снова.';
  }
  if (m.includes('rate limit') || m.includes('too many')) {
    return 'Слишком много попыток. Подождите несколько минут.';
  }
  if (m.includes('already registered') || m.includes('already been registered')) {
    return 'Комната с этим email уже есть. Войдите или восстановите пароль.';
  }
  if (m.includes('password') && (m.includes('weak') || m.includes('short'))) {
    return 'Пароль слишком простой. Используйте не менее 6 символов.';
  }
  if (m.includes('invalid') && m.includes('email')) {
    return 'Некорректный email. Проверьте опечатки.';
  }
  if (m.includes('signup') && m.includes('disabled')) {
    return 'Регистрация временно отключена на стороне сервера.';
  }
  if (m.includes('captcha')) {
    return 'В Supabase включена captcha, но в приложении она не настроена.';
  }

  return 'Не получилось создать комнату. Попробуйте другой email или войдите, если уже регистрировались.';
}

/** User-facing text for Supabase Auth errors (password reset, etc.). */
export function mapResetPasswordError(message: string): string {
  const m = message.toLowerCase();

  if (m.includes('rate limit') || m.includes('too many')) {
    return 'Слишком много запросов. Подождите 5–10 минут и попробуйте снова.';
  }
  if (m.includes('redirect') || m.includes('url is not allowed')) {
    return 'Адрес приложения не добавлен в Supabase → Authentication → URL Configuration → Redirect URLs (нужен тот же адрес, что в браузере, например http://localhost:5173).';
  }
  if (
    m.includes('smtp')
    || m.includes('sending')
    || m.includes('mail')
    || m.includes('email provider')
  ) {
    return 'Supabase не смог отправить письмо. Чаще всего: включён Custom SMTP с неверным паролем/хостом — проверьте SMTP Settings или временно отключите Custom SMTP.';
  }
  if (m.includes('invalid') && m.includes('email')) {
    return 'Некорректный email. Проверьте опечатки.';
  }
  if (m.includes('captcha')) {
    return 'В Supabase включена captcha для Auth, но в приложении она не настроена. Отключите captcha в Dashboard или настройте Turnstile/hCaptcha.';
  }

  return `Не удалось отправить письмо: ${message}`;
}
