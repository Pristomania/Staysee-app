# Browser regression checks

`recovery-regressions.html` exercises the real AuthProvider, ConversationListScreen and ConversationAccessGate with React StrictMode. Only the external Supabase auth/profile boundary is controlled by the tests. No real password, registration, chat message, model call or payment is used.

Start the existing Vite dev server with the normal public local Supabase URL/anon configuration, open `/tests/browser/recovery-regressions.html`, and click **Запустить регрессии**. The final visible JSON must show PASS for every case. The slow-plan cases use real8-second timers; the cache consumer case uses real19/21-second waits. CSS onset starts from a MutationObserver notification and samples computed ancestor opacity every50ms (rAF is paint-throttled in some embedded browsers). This page does not run as part of `test:offline`; browser execution must be reported separately. Do not edit source during the run: Vite HMR can reload the page and discard results.

Node/SSR coverage for the initial-plan notice is in `scripts/plan-verification-notice.test.ts` and runs in the offline suite. Product typechecking covers `src`, not the Node test scripts.

The temporary acceptance dashboard, AuthStateProbe and loopback-only instrumenting server were retained outside Git beside the acceptance report, not shipped as application entrypoints. They must not be imported into the production App or deployed. The final report records the controlled real-stack observations separately from component regressions and production observations.
