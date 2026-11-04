# dmgbuild's settings for TabTasker Dictate's DMG (scripts/release-mac.sh passes -D app=<the .app>): a window of
# 660 by 400 with no toolbar or sidebar, design/dmg-background.tiff behind, the app at the left end of its arc
# and Applications at the right, the app's own icon on the volume, and nothing else in it.
import os.path

app = defines["app"]  # noqa: F821 (dmgbuild supplies it)
name = os.path.basename(app)

format = "UDZO"
filesystem = "HFS+"
files = [app]
symlinks = {"Applications": "/Applications"}
icon = os.path.join(app, "Contents", "Resources", "icon.icns")
hide_extension = [name]

background = "design/dmg-background.tiff"  # from the repository root, where release-mac.sh runs (dmgbuild gives no __file__)
window_rect = ((200, 140), (660, 432))  # the 400 of the background, and Finder's title bar above it
default_view = "icon-view"
show_status_bar = show_tab_view = show_toolbar = show_pathbar = show_sidebar = False
show_icon_preview = False
icon_size = 128
text_size = 13
icon_locations = {name: (170, 196), "Applications": (490, 196)}
