# Compact conversation arrows — approved22.11

Owner chose the «Без рамок» mockup and explicitly approved implementing it.

Use thin14px arrows without outlined boxes, quiet12px «Готово», transparent buttons and a46px-or-shorter control row. Keep at least44×44px non-overlapping hit areas, the parent theme's secondary color and visible keyboard focus. Direction, edge disabling, request/owner guards, focus restoration and server persistence do not change.

Approaches: shrinking clickable targets would harm phone usability; inline transparent controls retain the targets while removing visual bulk. The approved choice is transparent controls, not new gestures or moving controls into the title.

Only ConversationOrderControls presentation changes; no SQL/RPC/plan/chat/memory/payment changes, no production deployment. Update existing draft219 after tests. Physical phones and the original iPhone blank space remain unverified.
