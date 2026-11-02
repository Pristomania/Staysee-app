/**
 * Whether the app can take money yet. False until the payment service (Robokassa) is connected: the shop must first be
 * approved, then the keys, the payment notification and the receipts come. While false the button of a paid plan does
 * not pretend to pay: it says that payment is coming.
 */
export const PAYMENT_AVAILABLE = false;
