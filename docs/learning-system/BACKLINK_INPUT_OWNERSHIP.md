# Backlink / LingQ click ownership

The integration audit found that the backlink controller observed document
capture events independently of the existing Bridge click policy. A linked word
could therefore start LingQ immediately and also queue a backlink; annotation
tool and completed-pan guards applied only to LingQ.

Two added regressions failed before the repair (19/21 passed). After repair,
controller, LingQ transition and InputRouter boundary suites passed 34/34.

The production controller now receives pointer intents through the existing
Bridge ownership hook. It does not install a second click, double-click or
pointerdown listener. Its existing keyboard and visibility lifecycle remain.
An exact backlink hit owns the click; otherwise the existing LingQ handler runs.
Both share the established tool/Pencil/pan guards. A delayed click rechecks the
current session and current tool eligibility before posting navigation.

No InputRouter, InteractionIntent, annotation state, index or persistence API
changed. Browser verification of this integration is required separately from
these unit results.
