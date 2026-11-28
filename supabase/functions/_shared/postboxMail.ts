/**
 * One letter through Yandex Postbox, the same way the sign-in letters leave (auth-email): our own socket, so that it can be
 * closed for sure, TLS required.
 */
import nodemailer from "npm:nodemailer@10.3.1";
import { createConnection, type Socket } from "node:net";

import type { PostboxMail } from "./ownerAlert.ts";

const HOST = "postbox.cloud.yandex.net";
const PORT = 587;

export async function sendPostboxMail(mail: PostboxMail): Promise<void> {
  let socket: Socket | undefined;
  const transport = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: false,
    requireTLS: true,
    auth: { user: mail.user, pass: mail.password },
    connectionTimeout: 2500,
    greetingTimeout: 2500,
    socketTimeout: 3500,
    tls: { minVersion: "TLSv1.2" as const, rejectUnauthorized: true },
    getSocket: (_options, callback) => {
      let returned = false;
      socket = createConnection({ host: HOST, port: PORT });
      const finish = (error: Error | null) => {
        if (returned) return;
        returned = true;
        callback(error, error ? false : { connection: socket! });
      };
      socket.once("connect", () => finish(null));
      socket.once("error", (error) => finish(error));
      socket.once("close", () => finish(new Error("mail_connection_closed")));
    },
  });
  try {
    const result = await transport.sendMail({ from: mail.from, to: mail.to, subject: mail.subject, text: mail.text });
    if (!result.accepted?.length || result.rejected?.length) throw new Error("mail_not_accepted");
  } finally {
    socket?.destroy();
    transport.close();
  }
}
