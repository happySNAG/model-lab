// Captured telemetry · codex-cli 0.155.0, verbatim from a loopback collector on 2026-09-20.
//
// These are the REAL payloads from the four-request Codex identity smoke, taken from the evidence
// file exactly as the redactor wrote them — which is why the conversation ids read
// `[REDACTED:conversation.id:N]`. Nothing identifying was in the file to copy, and the placeholders
// serve as opaque conversation ids perfectly well.
//
// WHY THEY ARE HERE. 0.154.0 exported the applied effort on a TRACE span that carried
// `conversation.id`. 0.155.0 exports it on the `codex.conversation_starts` LOG record as a flat
// `reasoning_effort`, and its spans carry NO `conversation.id` at all. The observer read only the
// 0.154.0 names, so all four of these conversations were recorded as `correlated: false` with the
// effort unavailable, while the evidence sat in the file. The fixture is the regression.
//
// THE SPAN BELOW IS THE TRAP. `codex_models_manager::manager` names `gpt-5.6-luna` — a model that
// was never requested and never answered — during startup. It is here so a test can prove that
// startup tracing stays out of a request's observation. It carries no `conversation.id`, which is
// exactly why it must never join to one.

/** One real `codex.conversation_starts` payload, with what the CLI said it was doing. */
export interface CapturedConversationStart {
  /** The conversation id, as the redactor wrote it. Opaque, and the join key. */
  readonly conversationID: string;
  /** The model this client REQUESTED. Never evidence of which model answered. */
  readonly requestedModel: string;
  /** The effort the CLI says it applied. */
  readonly appliedEffort: string;
  /** The OTLP payload, verbatim. */
  readonly payload: unknown;
}

export const CODEX_0155_CONVERSATION_STARTS: readonly CapturedConversationStart[] = [
  {
    conversationID: "[REDACTED:conversation.id:1]",
    requestedModel: "gpt-5.6-sol",
    appliedEffort: "medium",
    payload: {
      "resourceLogs": [
        {
          "resource": {
            "attributes": [
              {
                "key": "service.version",
                "value": {
                  "stringValue": "0.155.0"
                }
              },
              {
                "key": "telemetry.sdk.version",
                "value": {
                  "stringValue": "0.31.0"
                }
              },
              {
                "key": "telemetry.sdk.name",
                "value": {
                  "stringValue": "opentelemetry"
                }
              },
              {
                "key": "telemetry.sdk.language",
                "value": {
                  "stringValue": "rust"
                }
              },
              {
                "key": "env",
                "value": {
                  "stringValue": "dev"
                }
              },
              {
                "key": "service.name",
                "value": {
                  "stringValue": "codex_exec"
                }
              },
              {
                "key": "host.name",
                "value": {
                  "stringValue": "[REDACTED:host.name:2]"
                }
              }
            ],
            "droppedAttributesCount": 0,
            "entityRefs": []
          },
          "scopeLogs": [
            {
              "logRecords": [
                {
                  "timeUnixNano": "0",
                  "observedTimeUnixNano": "1789928824163307000",
                  "severityNumber": 9,
                  "severityText": "INFO",
                  "body": null,
                  "attributes": [
                    {
                      "key": "event.name",
                      "value": {
                        "stringValue": "codex.conversation_starts"
                      }
                    },
                    {
                      "key": "provider_name",
                      "value": {
                        "stringValue": "OpenAI"
                      }
                    },
                    {
                      "key": "auth.env_openai_api_key_present",
                      "value": {
                        "boolValue": false
                      }
                    },
                    {
                      "key": "auth.env_codex_api_key_present",
                      "value": {
                        "boolValue": false
                      }
                    },
                    {
                      "key": "auth.env_codex_api_key_enabled",
                      "value": {
                        "boolValue": true
                      }
                    },
                    {
                      "key": "auth.env_refresh_token_url_override_present",
                      "value": {
                        "boolValue": false
                      }
                    },
                    {
                      "key": "reasoning_effort",
                      "value": {
                        "stringValue": "medium"
                      }
                    },
                    {
                      "key": "reasoning_summary",
                      "value": {
                        "stringValue": "auto"
                      }
                    },
                    {
                      "key": "approval_policy",
                      "value": {
                        "stringValue": "never"
                      }
                    },
                    {
                      "key": "sandbox_policy",
                      "value": {
                        "stringValue": "read-only"
                      }
                    },
                    {
                      "key": "mcp_servers",
                      "value": {
                        "stringValue": ""
                      }
                    },
                    {
                      "key": "event.timestamp",
                      "value": {
                        "stringValue": "2026-09-20T18:27:04.163Z"
                      }
                    },
                    {
                      "key": "conversation.id",
                      "value": {
                        "stringValue": "[REDACTED:conversation.id:1]"
                      }
                    },
                    {
                      "key": "app.version",
                      "value": {
                        "stringValue": "0.155.0"
                      }
                    },
                    {
                      "key": "auth_mode",
                      "value": {
                        "stringValue": "Chatgpt"
                      }
                    },
                    {
                      "key": "originator",
                      "value": {
                        "stringValue": "codex_exec"
                      }
                    },
                    {
                      "key": "user.account_id",
                      "value": {
                        "stringValue": "[REDACTED:user.account_id:3]"
                      }
                    },
                    {
                      "key": "user.email",
                      "value": {
                        "stringValue": "[REDACTED:user.email:4]"
                      }
                    },
                    {
                      "key": "terminal.type",
                      "value": {
                        "stringValue": "Apple_Terminal/488"
                      }
                    },
                    {
                      "key": "model",
                      "value": {
                        "stringValue": "gpt-5.6-sol"
                      }
                    },
                    {
                      "key": "slug",
                      "value": {
                        "stringValue": "gpt-5.6-sol"
                      }
                    }
                  ],
                  "droppedAttributesCount": 0,
                  "flags": 1,
                  "traceId": "4b7791c0c847cb961a46a557df1d04e2",
                  "spanId": "033b873130b05d9f",
                  "eventName": "event otel/src/events/session_telemetry.rs:593"
                }
              ]
            }
          ]
        }
      ]
    },
  },
  {
    conversationID: "[REDACTED:conversation.id:5]",
    requestedModel: "gpt-5.6-sol",
    appliedEffort: "max",
    payload: {
      "resourceLogs": [
        {
          "resource": {
            "attributes": [
              {
                "key": "host.name",
                "value": {
                  "stringValue": "[REDACTED:host.name:2]"
                }
              },
              {
                "key": "telemetry.sdk.language",
                "value": {
                  "stringValue": "rust"
                }
              },
              {
                "key": "telemetry.sdk.version",
                "value": {
                  "stringValue": "0.31.0"
                }
              },
              {
                "key": "service.version",
                "value": {
                  "stringValue": "0.155.0"
                }
              },
              {
                "key": "env",
                "value": {
                  "stringValue": "dev"
                }
              },
              {
                "key": "telemetry.sdk.name",
                "value": {
                  "stringValue": "opentelemetry"
                }
              },
              {
                "key": "service.name",
                "value": {
                  "stringValue": "codex_exec"
                }
              }
            ],
            "droppedAttributesCount": 0,
            "entityRefs": []
          },
          "scopeLogs": [
            {
              "logRecords": [
                {
                  "timeUnixNano": "0",
                  "observedTimeUnixNano": "1789928828064579000",
                  "severityNumber": 9,
                  "severityText": "INFO",
                  "body": null,
                  "attributes": [
                    {
                      "key": "event.name",
                      "value": {
                        "stringValue": "codex.conversation_starts"
                      }
                    },
                    {
                      "key": "provider_name",
                      "value": {
                        "stringValue": "OpenAI"
                      }
                    },
                    {
                      "key": "auth.env_openai_api_key_present",
                      "value": {
                        "boolValue": false
                      }
                    },
                    {
                      "key": "auth.env_codex_api_key_present",
                      "value": {
                        "boolValue": false
                      }
                    },
                    {
                      "key": "auth.env_codex_api_key_enabled",
                      "value": {
                        "boolValue": true
                      }
                    },
                    {
                      "key": "auth.env_refresh_token_url_override_present",
                      "value": {
                        "boolValue": false
                      }
                    },
                    {
                      "key": "reasoning_effort",
                      "value": {
                        "stringValue": "max"
                      }
                    },
                    {
                      "key": "reasoning_summary",
                      "value": {
                        "stringValue": "auto"
                      }
                    },
                    {
                      "key": "approval_policy",
                      "value": {
                        "stringValue": "never"
                      }
                    },
                    {
                      "key": "sandbox_policy",
                      "value": {
                        "stringValue": "read-only"
                      }
                    },
                    {
                      "key": "mcp_servers",
                      "value": {
                        "stringValue": ""
                      }
                    },
                    {
                      "key": "event.timestamp",
                      "value": {
                        "stringValue": "2026-09-20T18:27:08.064Z"
                      }
                    },
                    {
                      "key": "conversation.id",
                      "value": {
                        "stringValue": "[REDACTED:conversation.id:5]"
                      }
                    },
                    {
                      "key": "app.version",
                      "value": {
                        "stringValue": "0.155.0"
                      }
                    },
                    {
                      "key": "auth_mode",
                      "value": {
                        "stringValue": "Chatgpt"
                      }
                    },
                    {
                      "key": "originator",
                      "value": {
                        "stringValue": "codex_exec"
                      }
                    },
                    {
                      "key": "user.account_id",
                      "value": {
                        "stringValue": "[REDACTED:user.account_id:3]"
                      }
                    },
                    {
                      "key": "user.email",
                      "value": {
                        "stringValue": "[REDACTED:user.email:4]"
                      }
                    },
                    {
                      "key": "terminal.type",
                      "value": {
                        "stringValue": "Apple_Terminal/488"
                      }
                    },
                    {
                      "key": "model",
                      "value": {
                        "stringValue": "gpt-5.6-sol"
                      }
                    },
                    {
                      "key": "slug",
                      "value": {
                        "stringValue": "gpt-5.6-sol"
                      }
                    }
                  ],
                  "droppedAttributesCount": 0,
                  "flags": 1,
                  "traceId": "80b90a6368c9a0628f4ecd2e9ba04d13",
                  "spanId": "8c44b6a98f08653b",
                  "eventName": "event otel/src/events/session_telemetry.rs:593"
                }
              ]
            }
          ]
        }
      ]
    },
  },
  {
    conversationID: "[REDACTED:conversation.id:6]",
    requestedModel: "gpt-6-astra",
    appliedEffort: "medium",
    payload: {
      "resourceLogs": [
        {
          "resource": {
            "attributes": [
              {
                "key": "telemetry.sdk.version",
                "value": {
                  "stringValue": "0.31.0"
                }
              },
              {
                "key": "service.name",
                "value": {
                  "stringValue": "codex_exec"
                }
              },
              {
                "key": "env",
                "value": {
                  "stringValue": "dev"
                }
              },
              {
                "key": "telemetry.sdk.name",
                "value": {
                  "stringValue": "opentelemetry"
                }
              },
              {
                "key": "host.name",
                "value": {
                  "stringValue": "[REDACTED:host.name:2]"
                }
              },
              {
                "key": "service.version",
                "value": {
                  "stringValue": "0.155.0"
                }
              },
              {
                "key": "telemetry.sdk.language",
                "value": {
                  "stringValue": "rust"
                }
              }
            ],
            "droppedAttributesCount": 0,
            "entityRefs": []
          },
          "scopeLogs": [
            {
              "logRecords": [
                {
                  "timeUnixNano": "0",
                  "observedTimeUnixNano": "1789928831694485000",
                  "severityNumber": 9,
                  "severityText": "INFO",
                  "body": null,
                  "attributes": [
                    {
                      "key": "event.name",
                      "value": {
                        "stringValue": "codex.conversation_starts"
                      }
                    },
                    {
                      "key": "provider_name",
                      "value": {
                        "stringValue": "OpenAI"
                      }
                    },
                    {
                      "key": "auth.env_openai_api_key_present",
                      "value": {
                        "boolValue": false
                      }
                    },
                    {
                      "key": "auth.env_codex_api_key_present",
                      "value": {
                        "boolValue": false
                      }
                    },
                    {
                      "key": "auth.env_codex_api_key_enabled",
                      "value": {
                        "boolValue": true
                      }
                    },
                    {
                      "key": "auth.env_refresh_token_url_override_present",
                      "value": {
                        "boolValue": false
                      }
                    },
                    {
                      "key": "reasoning_effort",
                      "value": {
                        "stringValue": "medium"
                      }
                    },
                    {
                      "key": "reasoning_summary",
                      "value": {
                        "stringValue": "auto"
                      }
                    },
                    {
                      "key": "approval_policy",
                      "value": {
                        "stringValue": "never"
                      }
                    },
                    {
                      "key": "sandbox_policy",
                      "value": {
                        "stringValue": "read-only"
                      }
                    },
                    {
                      "key": "mcp_servers",
                      "value": {
                        "stringValue": ""
                      }
                    },
                    {
                      "key": "event.timestamp",
                      "value": {
                        "stringValue": "2026-09-20T18:27:11.694Z"
                      }
                    },
                    {
                      "key": "conversation.id",
                      "value": {
                        "stringValue": "[REDACTED:conversation.id:6]"
                      }
                    },
                    {
                      "key": "app.version",
                      "value": {
                        "stringValue": "0.155.0"
                      }
                    },
                    {
                      "key": "auth_mode",
                      "value": {
                        "stringValue": "Chatgpt"
                      }
                    },
                    {
                      "key": "originator",
                      "value": {
                        "stringValue": "codex_exec"
                      }
                    },
                    {
                      "key": "user.account_id",
                      "value": {
                        "stringValue": "[REDACTED:user.account_id:3]"
                      }
                    },
                    {
                      "key": "user.email",
                      "value": {
                        "stringValue": "[REDACTED:user.email:4]"
                      }
                    },
                    {
                      "key": "terminal.type",
                      "value": {
                        "stringValue": "Apple_Terminal/488"
                      }
                    },
                    {
                      "key": "model",
                      "value": {
                        "stringValue": "gpt-6-astra"
                      }
                    },
                    {
                      "key": "slug",
                      "value": {
                        "stringValue": "gpt-6-astra"
                      }
                    }
                  ],
                  "droppedAttributesCount": 0,
                  "flags": 1,
                  "traceId": "c705e9f18e7ef44b52c5de56a7e19c68",
                  "spanId": "50572f45c4cee41b",
                  "eventName": "event otel/src/events/session_telemetry.rs:593"
                }
              ]
            }
          ]
        }
      ]
    },
  },
  {
    conversationID: "[REDACTED:conversation.id:7]",
    requestedModel: "gpt-6-astra",
    appliedEffort: "max",
    payload: {
      "resourceLogs": [
        {
          "resource": {
            "attributes": [
              {
                "key": "service.name",
                "value": {
                  "stringValue": "codex_exec"
                }
              },
              {
                "key": "service.version",
                "value": {
                  "stringValue": "0.155.0"
                }
              },
              {
                "key": "env",
                "value": {
                  "stringValue": "dev"
                }
              },
              {
                "key": "host.name",
                "value": {
                  "stringValue": "[REDACTED:host.name:2]"
                }
              },
              {
                "key": "telemetry.sdk.version",
                "value": {
                  "stringValue": "0.31.0"
                }
              },
              {
                "key": "telemetry.sdk.name",
                "value": {
                  "stringValue": "opentelemetry"
                }
              },
              {
                "key": "telemetry.sdk.language",
                "value": {
                  "stringValue": "rust"
                }
              }
            ],
            "droppedAttributesCount": 0,
            "entityRefs": []
          },
          "scopeLogs": [
            {
              "logRecords": [
                {
                  "timeUnixNano": "0",
                  "observedTimeUnixNano": "1789928835893516000",
                  "severityNumber": 9,
                  "severityText": "INFO",
                  "body": null,
                  "attributes": [
                    {
                      "key": "event.name",
                      "value": {
                        "stringValue": "codex.conversation_starts"
                      }
                    },
                    {
                      "key": "provider_name",
                      "value": {
                        "stringValue": "OpenAI"
                      }
                    },
                    {
                      "key": "auth.env_openai_api_key_present",
                      "value": {
                        "boolValue": false
                      }
                    },
                    {
                      "key": "auth.env_codex_api_key_present",
                      "value": {
                        "boolValue": false
                      }
                    },
                    {
                      "key": "auth.env_codex_api_key_enabled",
                      "value": {
                        "boolValue": true
                      }
                    },
                    {
                      "key": "auth.env_refresh_token_url_override_present",
                      "value": {
                        "boolValue": false
                      }
                    },
                    {
                      "key": "reasoning_effort",
                      "value": {
                        "stringValue": "max"
                      }
                    },
                    {
                      "key": "reasoning_summary",
                      "value": {
                        "stringValue": "auto"
                      }
                    },
                    {
                      "key": "approval_policy",
                      "value": {
                        "stringValue": "never"
                      }
                    },
                    {
                      "key": "sandbox_policy",
                      "value": {
                        "stringValue": "read-only"
                      }
                    },
                    {
                      "key": "mcp_servers",
                      "value": {
                        "stringValue": ""
                      }
                    },
                    {
                      "key": "event.timestamp",
                      "value": {
                        "stringValue": "2026-09-20T18:27:15.893Z"
                      }
                    },
                    {
                      "key": "conversation.id",
                      "value": {
                        "stringValue": "[REDACTED:conversation.id:7]"
                      }
                    },
                    {
                      "key": "app.version",
                      "value": {
                        "stringValue": "0.155.0"
                      }
                    },
                    {
                      "key": "auth_mode",
                      "value": {
                        "stringValue": "Chatgpt"
                      }
                    },
                    {
                      "key": "originator",
                      "value": {
                        "stringValue": "codex_exec"
                      }
                    },
                    {
                      "key": "user.account_id",
                      "value": {
                        "stringValue": "[REDACTED:user.account_id:3]"
                      }
                    },
                    {
                      "key": "user.email",
                      "value": {
                        "stringValue": "[REDACTED:user.email:4]"
                      }
                    },
                    {
                      "key": "terminal.type",
                      "value": {
                        "stringValue": "Apple_Terminal/488"
                      }
                    },
                    {
                      "key": "model",
                      "value": {
                        "stringValue": "gpt-6-astra"
                      }
                    },
                    {
                      "key": "slug",
                      "value": {
                        "stringValue": "gpt-6-astra"
                      }
                    }
                  ],
                  "droppedAttributesCount": 0,
                  "flags": 1,
                  "traceId": "cb7a9565ccce6eb21c0a6f5446d7cbd6",
                  "spanId": "559b2c45ddccee75",
                  "eventName": "event otel/src/events/session_telemetry.rs:593"
                }
              ]
            }
          ]
        }
      ]
    },
  },
];

/**
 * Startup tracing from `codex_models_manager::manager`, naming a model nobody asked for.
 *
 * No `conversation.id` anywhere in it. Feeding this to the observer must produce no observation and
 * must not touch an existing one.
 */
export const CODEX_0155_MODEL_MANAGER_SPAN: unknown = {
  "resourceSpans": [
    {
      "resource": {
        "attributes": [
          {
            "key": "env",
            "value": {
              "stringValue": "dev"
            }
          },
          {
            "key": "telemetry.sdk.language",
            "value": {
              "stringValue": "rust"
            }
          },
          {
            "key": "telemetry.sdk.name",
            "value": {
              "stringValue": "opentelemetry"
            }
          },
          {
            "key": "telemetry.sdk.version",
            "value": {
              "stringValue": "0.31.0"
            }
          },
          {
            "key": "service.name",
            "value": {
              "stringValue": "codex_exec"
            }
          },
          {
            "key": "service.version",
            "value": {
              "stringValue": "0.155.0"
            }
          }
        ],
        "droppedAttributesCount": 0,
        "entityRefs": []
      },
      "scopeSpans": [
        {
          "spans": [
            {
              "traceId": "4b7791c0c847cb961a46a557df1d04e2",
              "spanId": "07f36d800be6e763",
              "traceState": "",
              "parentSpanId": "033b873130b05d9f",
              "flags": 257,
              "name": "get_model_info",
              "kind": 1,
              "startTimeUnixNano": "1789928824223521000",
              "endTimeUnixNano": "1789928824223592000",
              "attributes": [
                {
                  "key": "code.file.path",
                  "value": {
                    "stringValue": "models-manager/src/manager.rs"
                  }
                },
                {
                  "key": "code.module.name",
                  "value": {
                    "stringValue": "codex_models_manager::manager"
                  }
                },
                {
                  "key": "code.line.number",
                  "value": {
                    "intValue": "224"
                  }
                },
                {
                  "key": "thread.id",
                  "value": {
                    "intValue": "3"
                  }
                },
                {
                  "key": "thread.name",
                  "value": {
                    "stringValue": "tokio-rt-worker"
                  }
                },
                {
                  "key": "target",
                  "value": {
                    "stringValue": "codex_models_manager::manager"
                  }
                },
                {
                  "key": "model",
                  "value": {
                    "stringValue": "gpt-5.6-luna"
                  }
                },
                {
                  "key": "busy_ns",
                  "value": {
                    "intValue": "56625"
                  }
                },
                {
                  "key": "idle_ns",
                  "value": {
                    "intValue": "14625"
                  }
                }
              ],
              "droppedAttributesCount": 0,
              "events": [],
              "droppedEventsCount": 0,
              "links": [],
              "droppedLinksCount": 0,
              "status": {
                "message": "",
                "code": 0
              }
            }
          ]
        }
      ]
    }
  ]
};

/**
 * The two `codex.sse_event` / `response.completed` records 0.155.0 wrote for ONE request on the HTTP/SSE
 * transport, verbatim from a real-binary loopback matrix run on 2026-09-21 (no provider contacted).
 *
 * THE FIRST ONE IS BARE: a duration and nothing else. The second carries the counts and
 * `model_reasoning_effort`. They share one `event.timestamp`, so an observer that de-duplicated by
 * timestamp kept the bare record and threw the usage away. Note the value types, which are the tool's
 * own: `input_token_count`, `output_token_count` and `tool_token_count` are strings; the cached, cache-write
 * and reasoning counts are integers. (The live WebSocket captures of 2026-09-20/21 have no bare record.)
 */
export const CODEX_0155_HTTP_SSE_COMPLETED_PAIR: unknown = {
  "resourceLogs": [
    {
      "resource": {
        "attributes": [
          {
            "key": "service.version",
            "value": {
              "stringValue": "0.155.0"
            }
          },
          {
            "key": "telemetry.sdk.name",
            "value": {
              "stringValue": "opentelemetry"
            }
          },
          {
            "key": "env",
            "value": {
              "stringValue": "dev"
            }
          },
          {
            "key": "telemetry.sdk.language",
            "value": {
              "stringValue": "rust"
            }
          },
          {
            "key": "telemetry.sdk.version",
            "value": {
              "stringValue": "0.31.0"
            }
          },
          {
            "key": "host.name",
            "value": {
              "stringValue": "[REDACTED:host.name:4]"
            }
          },
          {
            "key": "service.name",
            "value": {
              "stringValue": "codex_exec"
            }
          }
        ],
        "droppedAttributesCount": 0,
        "entityRefs": []
      },
      "scopeLogs": [
        {
          "scope": {
            "name": "codex_otel.log_only",
            "version": "",
            "attributes": [],
            "droppedAttributesCount": 0
          },
          "logRecords": [
            {
              "timeUnixNano": "0",
              "observedTimeUnixNano": "1790038185532348000",
              "severityNumber": 9,
              "severityText": "INFO",
              "body": null,
              "attributes": [
                {
                  "key": "event.name",
                  "value": {
                    "stringValue": "codex.sse_event"
                  }
                },
                {
                  "key": "event.kind",
                  "value": {
                    "stringValue": "response.completed"
                  }
                },
                {
                  "key": "duration_ms",
                  "value": {
                    "stringValue": "0"
                  }
                },
                {
                  "key": "event.timestamp",
                  "value": {
                    "stringValue": "2026-09-22T00:49:45.532Z"
                  }
                },
                {
                  "key": "conversation.id",
                  "value": {
                    "stringValue": "[REDACTED:conversation.id:1]"
                  }
                },
                {
                  "key": "app.version",
                  "value": {
                    "stringValue": "0.155.0"
                  }
                },
                {
                  "key": "auth_mode",
                  "value": {
                    "stringValue": "Chatgpt"
                  }
                },
                {
                  "key": "originator",
                  "value": {
                    "stringValue": "codex_exec"
                  }
                },
                {
                  "key": "user.account_id",
                  "value": {
                    "stringValue": "[REDACTED:user.account_id:5]"
                  }
                },
                {
                  "key": "user.email",
                  "value": {
                    "stringValue": "[REDACTED:user.email:6]"
                  }
                },
                {
                  "key": "terminal.type",
                  "value": {
                    "stringValue": "unknown"
                  }
                },
                {
                  "key": "model",
                  "value": {
                    "stringValue": "gpt-5.6-sol"
                  }
                },
                {
                  "key": "slug",
                  "value": {
                    "stringValue": "gpt-5.6-sol"
                  }
                }
              ],
              "droppedAttributesCount": 0,
              "flags": 0,
              "traceId": "",
              "spanId": "",
              "eventName": "event otel/src/events/session_telemetry.rs:971"
            },
            {
              "timeUnixNano": "0",
              "observedTimeUnixNano": "1790038185532369000",
              "severityNumber": 9,
              "severityText": "INFO",
              "body": null,
              "attributes": [
                {
                  "key": "event.name",
                  "value": {
                    "stringValue": "codex.sse_event"
                  }
                },
                {
                  "key": "event.kind",
                  "value": {
                    "stringValue": "response.completed"
                  }
                },
                {
                  "key": "input_token_count",
                  "value": {
                    "stringValue": "1000"
                  }
                },
                {
                  "key": "output_token_count",
                  "value": {
                    "stringValue": "50"
                  }
                },
                {
                  "key": "cached_token_count",
                  "value": {
                    "intValue": "400"
                  }
                },
                {
                  "key": "cache_write_token_count",
                  "value": {
                    "intValue": "0"
                  }
                },
                {
                  "key": "reasoning_token_count",
                  "value": {
                    "intValue": "20"
                  }
                },
                {
                  "key": "tool_token_count",
                  "value": {
                    "stringValue": "1050"
                  }
                },
                {
                  "key": "model_reasoning_effort",
                  "value": {
                    "stringValue": "medium"
                  }
                },
                {
                  "key": "event.timestamp",
                  "value": {
                    "stringValue": "2026-09-22T00:49:45.532Z"
                  }
                },
                {
                  "key": "conversation.id",
                  "value": {
                    "stringValue": "[REDACTED:conversation.id:1]"
                  }
                },
                {
                  "key": "app.version",
                  "value": {
                    "stringValue": "0.155.0"
                  }
                },
                {
                  "key": "auth_mode",
                  "value": {
                    "stringValue": "Chatgpt"
                  }
                },
                {
                  "key": "originator",
                  "value": {
                    "stringValue": "codex_exec"
                  }
                },
                {
                  "key": "user.account_id",
                  "value": {
                    "stringValue": "[REDACTED:user.account_id:5]"
                  }
                },
                {
                  "key": "user.email",
                  "value": {
                    "stringValue": "[REDACTED:user.email:6]"
                  }
                },
                {
                  "key": "terminal.type",
                  "value": {
                    "stringValue": "unknown"
                  }
                },
                {
                  "key": "model",
                  "value": {
                    "stringValue": "gpt-5.6-sol"
                  }
                },
                {
                  "key": "slug",
                  "value": {
                    "stringValue": "gpt-5.6-sol"
                  }
                }
              ],
              "droppedAttributesCount": 0,
              "flags": 0,
              "traceId": "",
              "spanId": "",
              "eventName": "event otel/src/events/session_telemetry.rs:1035"
            }
          ]
        }
      ]
    }
  ]
};

/**
 * Four spans from the same run, verbatim, that carry the CONVERSATION ID under names other than
 * `conversation.id`: `thread.id` (beside the OS thread's own integer `thread.id`), `thread_id`, and inside a
 * debug string, `Thread { thread_id: "…" }`. The observer's key-based redactor let all of them reach the
 * evidence file in clear. Here they read `[REDACTED:conversation.id:1]` because this capture was taken
 * after the fix; a test puts a raw id back to show it no longer survives.
 */
export const CODEX_0155_SPANS_CARRYING_THE_CONVERSATION: unknown = {
  "resourceSpans": [
    {
      "resource": {
        "attributes": [
          {
            "key": "service.name",
            "value": {
              "stringValue": "codex_exec"
            }
          },
          {
            "key": "env",
            "value": {
              "stringValue": "dev"
            }
          },
          {
            "key": "service.version",
            "value": {
              "stringValue": "0.155.0"
            }
          },
          {
            "key": "telemetry.sdk.name",
            "value": {
              "stringValue": "opentelemetry"
            }
          },
          {
            "key": "telemetry.sdk.language",
            "value": {
              "stringValue": "rust"
            }
          },
          {
            "key": "telemetry.sdk.version",
            "value": {
              "stringValue": "0.31.0"
            }
          }
        ],
        "droppedAttributesCount": 0,
        "entityRefs": []
      },
      "scopeSpans": [
        {
          "scope": {
            "name": "codex_exec",
            "version": "",
            "attributes": [],
            "droppedAttributesCount": 0
          },
          "spans": [
            {
              "traceId": "7eab96e910caef3d6cd3f81f6326a79b",
              "spanId": "88589b10d271f804",
              "traceState": "",
              "parentSpanId": "2d81c97a81b35b98",
              "flags": 257,
              "name": "app_server.serialized_request_queue",
              "kind": 1,
              "startTimeUnixNano": "1790038185516315000",
              "endTimeUnixNano": "1790038185518459000",
              "attributes": [
                {
                  "key": "code.file.path",
                  "value": {
                    "stringValue": "app-server/src/request_serialization.rs"
                  }
                },
                {
                  "key": "code.module.name",
                  "value": {
                    "stringValue": "codex_app_server::request_serialization"
                  }
                },
                {
                  "key": "code.line.number",
                  "value": {
                    "intValue": "228"
                  }
                },
                {
                  "key": "thread.id",
                  "value": {
                    "intValue": "6"
                  }
                },
                {
                  "key": "thread.name",
                  "value": {
                    "stringValue": "tokio-rt-worker"
                  }
                },
                {
                  "key": "target",
                  "value": {
                    "stringValue": "codex_app_server::request_serialization"
                  }
                },
                {
                  "key": "key",
                  "value": {
                    "stringValue": "Thread { thread_id: \"[REDACTED:conversation.id:1]\" }"
                  }
                },
                {
                  "key": "busy_ns",
                  "value": {
                    "intValue": "236959"
                  }
                },
                {
                  "key": "idle_ns",
                  "value": {
                    "intValue": "1906916"
                  }
                }
              ],
              "droppedAttributesCount": 0,
              "events": [],
              "droppedEventsCount": 0,
              "links": [],
              "droppedLinksCount": 0,
              "status": {
                "message": "",
                "code": 0
              }
            },
            {
              "traceId": "7eab96e910caef3d6cd3f81f6326a79b",
              "spanId": "6131fccb1976b34a",
              "traceState": "",
              "parentSpanId": "6fdd046bd385729c",
              "flags": 257,
              "name": "session_task.turn",
              "kind": 1,
              "startTimeUnixNano": "1790038185518409000",
              "endTimeUnixNano": "1790038185533391000",
              "attributes": [
                {
                  "key": "code.file.path",
                  "value": {
                    "stringValue": "core/src/tasks/mod.rs"
                  }
                },
                {
                  "key": "code.module.name",
                  "value": {
                    "stringValue": "codex_core::tasks"
                  }
                },
                {
                  "key": "code.line.number",
                  "value": {
                    "intValue": "345"
                  }
                },
                {
                  "key": "thread.id",
                  "value": {
                    "intValue": "10"
                  }
                },
                {
                  "key": "thread.name",
                  "value": {
                    "stringValue": "tokio-rt-worker"
                  }
                },
                {
                  "key": "target",
                  "value": {
                    "stringValue": "codex_core::tasks"
                  }
                },
                {
                  "key": "thread.id",
                  "value": {
                    "stringValue": "[REDACTED:conversation.id:1]"
                  }
                },
                {
                  "key": "turn.id",
                  "value": {
                    "stringValue": "[REDACTED:identifier:2]"
                  }
                },
                {
                  "key": "model",
                  "value": {
                    "stringValue": "gpt-5.6-sol"
                  }
                },
                {
                  "key": "codex.turn.reasoning_effort",
                  "value": {
                    "stringValue": "medium"
                  }
                },
                {
                  "key": "codex.turn.token_usage.input_tokens",
                  "value": {
                    "intValue": "1000"
                  }
                },
                {
                  "key": "codex.turn.token_usage.cached_input_tokens",
                  "value": {
                    "intValue": "400"
                  }
                },
                {
                  "key": "codex.turn.token_usage.cache_write_input_tokens",
                  "value": {
                    "intValue": "0"
                  }
                },
                {
                  "key": "codex.turn.token_usage.non_cached_input_tokens",
                  "value": {
                    "intValue": "600"
                  }
                },
                {
                  "key": "codex.turn.token_usage.output_tokens",
                  "value": {
                    "intValue": "50"
                  }
                },
                {
                  "key": "codex.turn.token_usage.reasoning_output_tokens",
                  "value": {
                    "intValue": "20"
                  }
                },
                {
                  "key": "codex.turn.token_usage.total_tokens",
                  "value": {
                    "intValue": "1050"
                  }
                },
                {
                  "key": "busy_ns",
                  "value": {
                    "intValue": "13581875"
                  }
                },
                {
                  "key": "idle_ns",
                  "value": {
                    "intValue": "1400625"
                  }
                }
              ],
              "droppedAttributesCount": 0,
              "events": [],
              "droppedEventsCount": 0,
              "links": [],
              "droppedLinksCount": 0,
              "status": {
                "message": "",
                "code": 0
              }
            },
            {
              "traceId": "6f458651454f05bb7bf8526c43efcea3",
              "spanId": "04b0f332b9cc6fe9",
              "traceState": "",
              "parentSpanId": "",
              "flags": 257,
              "name": "session_loop",
              "kind": 1,
              "startTimeUnixNano": "1790038185512819000",
              "endTimeUnixNano": "1790038185534395000",
              "attributes": [
                {
                  "key": "code.file.path",
                  "value": {
                    "stringValue": "core/src/session/mod.rs"
                  }
                },
                {
                  "key": "code.module.name",
                  "value": {
                    "stringValue": "codex_core::session"
                  }
                },
                {
                  "key": "code.line.number",
                  "value": {
                    "intValue": "874"
                  }
                },
                {
                  "key": "thread.id",
                  "value": {
                    "intValue": "5"
                  }
                },
                {
                  "key": "thread.name",
                  "value": {
                    "stringValue": "tokio-rt-worker"
                  }
                },
                {
                  "key": "target",
                  "value": {
                    "stringValue": "codex_core::session"
                  }
                },
                {
                  "key": "thread_id",
                  "value": {
                    "stringValue": "[REDACTED:conversation.id:1]"
                  }
                },
                {
                  "key": "busy_ns",
                  "value": {
                    "intValue": "1447544"
                  }
                },
                {
                  "key": "idle_ns",
                  "value": {
                    "intValue": "20127998"
                  }
                }
              ],
              "droppedAttributesCount": 0,
              "events": [],
              "droppedEventsCount": 0,
              "links": [],
              "droppedLinksCount": 0,
              "status": {
                "message": "",
                "code": 0
              }
            },
            {
              "traceId": "a8e3cb9fafb2eff36ad66e88b1672e1d",
              "spanId": "9b247b1c8a95d5a9",
              "traceState": "",
              "parentSpanId": "",
              "flags": 257,
              "name": "codex.exec",
              "kind": 1,
              "startTimeUnixNano": "1790038185469804000",
              "endTimeUnixNano": "1790038185534697000",
              "attributes": [
                {
                  "key": "code.file.path",
                  "value": {
                    "stringValue": "exec/src/lib.rs"
                  }
                },
                {
                  "key": "code.module.name",
                  "value": {
                    "stringValue": "codex_exec"
                  }
                },
                {
                  "key": "code.line.number",
                  "value": {
                    "intValue": "243"
                  }
                },
                {
                  "key": "thread.id",
                  "value": {
                    "intValue": "2"
                  }
                },
                {
                  "key": "thread.name",
                  "value": {
                    "stringValue": "codex-main"
                  }
                },
                {
                  "key": "target",
                  "value": {
                    "stringValue": "codex_exec"
                  }
                },
                {
                  "key": "thread.id",
                  "value": {
                    "stringValue": "[REDACTED:conversation.id:1]"
                  }
                },
                {
                  "key": "turn.id",
                  "value": {
                    "stringValue": "[REDACTED:identifier:2]"
                  }
                },
                {
                  "key": "busy_ns",
                  "value": {
                    "intValue": "549291"
                  }
                },
                {
                  "key": "idle_ns",
                  "value": {
                    "intValue": "64344793"
                  }
                }
              ],
              "droppedAttributesCount": 0,
              "events": [],
              "droppedEventsCount": 0,
              "links": [],
              "droppedLinksCount": 0,
              "status": {
                "message": "",
                "code": 0
              }
            }
          ]
        }
      ]
    }
  ]
};
