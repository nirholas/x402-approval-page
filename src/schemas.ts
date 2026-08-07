/**
 * Per-route invocation contracts published inside every x402 402 challenge as
 * `accepts[].outputSchema` — `input` tells an agent how to build the request
 * (method, path/query params, JSON body fields), `output` is the JSON Schema of
 * the successful response body. An agent that has never seen this API can
 * therefore call it correctly straight from the challenge it just received.
 *
 * Derived from `openapi.json`, so the runtime challenge (which the x402scan
 * discovery spec treats as authoritative) can never contradict the published
 * spec. Keys match the paywall route map exactly: `"<VERB> /path"`, with `*`
 * standing in for a path parameter.
 */

/** The `outputSchema` value carried by every accept entry of a paid route. */
export type RouteSchema = {
  /** How to invoke the route: HTTP method, parameters, request body fields. */
  input: Record<string, unknown>;
  /** JSON Schema of the 2xx response body. */
  output: Record<string, unknown>;
};

/** Keyed exactly like the paywall route map — spread into each route entry. */
export const ROUTE_SCHEMAS: Record<string, { outputSchema: RouteSchema }> = {
  "GET /requests/*": {
    outputSchema: {
      "input": {
        "type": "http",
        "method": "GET",
        "path": "/requests/{id}",
        "pathParams": {
          "id": {
            "type": "string"
          }
        },
        "pathParamsRequired": [
          "id"
        ]
      },
      "output": {
        "type": "object",
        "properties": {
          "payload": {
            "type": "object",
            "properties": {
              "requestId": {
                "type": "string"
              },
              "decision": {
                "type": "string",
                "enum": [
                  "pending",
                  "approved",
                  "declined",
                  "expired"
                ]
              },
              "amountUsd": {
                "type": "number"
              },
              "currency": {
                "type": "string",
                "const": "USD"
              },
              "merchant": {
                "type": "string"
              },
              "resource": {
                "type": "string"
              },
              "description": {
                "type": "string"
              },
              "reason": {
                "type": "string"
              },
              "createdAt": {
                "type": "string",
                "format": "date-time"
              },
              "expiresAt": {
                "type": "string",
                "format": "date-time"
              },
              "decidedAt": {
                "type": [
                  "string",
                  "null"
                ],
                "format": "date-time"
              },
              "note": {
                "type": [
                  "string",
                  "null"
                ],
                "description": "what the human said when declining"
              },
              "paymentReceipt": {
                "type": [
                  "object",
                  "null"
                ],
                "description": "settlement receipt from the human's payment, present once approved",
                "properties": {
                  "success": {
                    "type": "boolean"
                  },
                  "rail": {
                    "type": "string",
                    "enum": [
                      "evm",
                      "solana"
                    ]
                  },
                  "network": {
                    "type": "string"
                  },
                  "transaction": {
                    "type": "string"
                  },
                  "payer": {
                    "type": "string"
                  }
                }
              },
              "grantToken": {
                "type": [
                  "string",
                  "null"
                ],
                "description": "proof a human authorized this purchase; issued on approval"
              },
              "secondsRemaining": {
                "type": "integer"
              },
              "checkedAt": {
                "type": "string",
                "format": "date-time"
              }
            },
            "required": [
              "requestId",
              "decision",
              "amountUsd",
              "merchant",
              "createdAt",
              "expiresAt",
              "checkedAt"
            ]
          },
          "signature": {
            "type": "string"
          },
          "algorithm": {
            "type": "string",
            "const": "HMAC-SHA256"
          },
          "canonicalization": {
            "type": "string",
            "const": "sorted-keys-json"
          }
        },
        "required": [
          "payload",
          "signature",
          "algorithm",
          "canonicalization"
        ]
      }
    },
  },
  "POST /requests/*/approve": {
    outputSchema: {
      "input": {
        "type": "http",
        "method": "POST",
        "path": "/requests/{id}/approve",
        "pathParams": {
          "id": {
            "type": "string"
          }
        },
        "pathParamsRequired": [
          "id"
        ]
      },
      "output": {
        "type": "object",
        "properties": {
          "payload": {
            "type": "object",
            "properties": {
              "requestId": {
                "type": "string"
              },
              "decision": {
                "type": "string",
                "const": "approved"
              },
              "amountUsd": {
                "type": "number"
              },
              "currency": {
                "type": "string",
                "const": "USD"
              },
              "merchant": {
                "type": "string"
              },
              "resource": {
                "type": "string"
              },
              "description": {
                "type": "string"
              },
              "approvedAt": {
                "type": "string",
                "format": "date-time"
              },
              "expiresAt": {
                "type": "string",
                "format": "date-time"
              },
              "grantToken": {
                "type": "string"
              },
              "paymentReceipt": {
                "type": [
                  "object",
                  "null"
                ]
              }
            },
            "required": [
              "requestId",
              "decision",
              "amountUsd",
              "approvedAt",
              "grantToken"
            ]
          },
          "signature": {
            "type": "string"
          },
          "algorithm": {
            "type": "string",
            "const": "HMAC-SHA256"
          },
          "canonicalization": {
            "type": "string",
            "const": "sorted-keys-json"
          }
        },
        "required": [
          "payload",
          "signature",
          "algorithm",
          "canonicalization"
        ]
      }
    },
  },
};
