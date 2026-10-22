# Sidebar row activation compatibility

Wrapping annotation content in a semantic navigation button accidentally narrowed click delegation to that child button. Bare `li.sidebarComment` padding/card-background clicks no longer reached the existing exact UUID navigator.

The repair restores row click delegation after the separate review-button branch. Keyboard handling remains on the semantic button. Enabled and disabled review actions remain zero-navigation; bare row clicks navigate the exact UUID/page and update selected state without creating a draft.

The added unit assertions failed before repair (`navigated=[]`, expected `[["b",1]]`). After the two-line delegation repair, external annotation bridge and SemanticAnchor units pass 32/32 with zero skipped. No Browser run was performed for this isolated repair.
