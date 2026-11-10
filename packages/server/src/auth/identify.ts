/** Who a request is from, once that has been proved. */
export type Identity = { email: string };

/**
 * "Who is this request from?" Every login method is one of these.
 *
 * Returns null when the request carries no valid proof of identity. Throws
 * only when the answer cannot be worked out at all, for example when the
 * identity provider's keys cannot be fetched.
 */
export type Identify = (request: Request) => Promise<Identity | null>;
