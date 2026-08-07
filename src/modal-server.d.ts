/**
 * The payment modal ships types for `/server` but not for the `/server/express`
 * adapter subpath, which a NodeNext resolver then treats as implicitly `any`.
 * Declare the one export we use so `tsc --noEmit` stays clean without loosening
 * `strict` anywhere else.
 */
declare module "@three-ws/x402-payment-modal/server/express" {
  import type { RequestHandler } from "express";
  export function x402CheckoutRouter(options?: {
    rpcUrl?: string;
    rpcUrls?: string[];
    devnetRpcUrl?: string;
    devnetRpcUrls?: string[];
    origin?: string;
    logger?: (...args: unknown[]) => void;
  }): RequestHandler;
}
