"use strict";

const Gio = imports.gi.Gio;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const Tweener = imports.tweener.tweener;
const Main = imports.ui.main;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const PanelBox = Main.layoutManager.panelBox;

const SchemaSource = Gio.SettingsSchemaSource.new_from_directory(
    Me.dir.get_path(), Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({
  settings_schema : SchemaSource.lookup(Me.metadata["settings-schema"], true)
});
const bindings = new Gio.Settings({
  settings_schema :
      SchemaSource.lookup(Me.metadata["settings-schema"] + ".keybindings", true)
});

function tileInit(win) {
  win.unmaximize(Meta.MaximizeFlags.BOTH);
  win._tilingnome = {idx : Infinity};
}

function tileInitAuto(win) {
  const types = settings.get_strv("auto-tile-window-types");
  const excludes = settings.get_strv("auto-tile-window-excludes");
  const title = win.get_title();
  if (types.some(t => win.window_type === Meta.WindowType[t]) &&
      !excludes.some(e => title.includes(e)))
    tileInit(win);
}

function tileDestroy(win) { delete win._tilingnome; }

function tileData(win) { return win._tilingnome; }

function tileCompare(w1, w2) {
  const i1 = tileData(w1);
  const i2 = tileData(w2);
  return i1.idx > i2.idx ? 1 : i1.idx < i2.idx ? -1 : 0;
}

function swapTiles(w1, w2) {
  const i1 = tileData(w1);
  const i2 = tileData(w2);
  if (!i1 || !i2)
    return;
  const tmp = i1.idx;
  refreshTile(w1, i2.idx);
  refreshTile(w2, tmp);
}

function addGaps(area, gaps) {
  return new Meta.Rectangle({
    x : Math.floor(area.x + gaps.x),
    y : Math.floor(area.y + gaps.y),
    width : Math.floor(area.width - gaps.width - gaps.x),
    height : Math.floor(area.height - gaps.height - gaps.y)
  });
}

function refreshTile(win, idx, rect) {
  const tile = tileData(win);
  if (tile.idx !== idx) {
    tile.idx = idx;
    const ming = settings.get_value("minimum-gaps").deep_unpack();
    const maxg = settings.get_value("maximum-gaps").deep_unpack();
    tile.gaps = new Meta.Rectangle(
        {x : ming[0], y : ming[1], width : ming[2], height : ming[3]});
  }
  if (!rect)
    return;
  rect = addGaps(rect, tile.gaps);
  Meta.later_add(Meta.LaterType.IDLE, () => {
    Tweener.addTween(win.get_compositor_private(), {
      transition : settings.get_string("animation-transition"),
      time : settings.get_double("animation-duration"),
      scale_x : 1,
      scale_y : 1,
      translation_x : 0,
      translation_y : 0,
      onStart : (actor, r1, r2) => {
        if ((actor.translation_x = r1.x - r2.x) > 0)
          actor.translation_x -= r2.width - r1.width;
        if ((actor.translation_y = r1.y - r2.y) > 0)
          actor.translation_y -= r2.height - r1.height;
        actor.set_pivot_point(r2.x >= r1.x ? 0 : 1, r2.y >= r1.y ? 0 : 1);
        actor.set_scale(r1.width / r2.width, r1.height / r2.height);
      },
      onStartParams :
          [ win.get_compositor_private(), win.get_frame_rect(), rect ]
    });
    win.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
  });
}

function refreshMonitor(mon) {
  const wksp = global.workspace_manager.get_active_workspace();
  const wins = wksp.list_windows()
                   .filter(win => win.get_monitor() === mon)
                   .filter(win => !win.fullscreen && !win.minimized)
                   .filter(tileData)
                   .sort(tileCompare);
  const [x, y, width, height] = settings.get_value("margins").deep_unpack();
  const area = addGaps(
      wksp.get_work_area_for_monitor(mon),
      new Meta.Rectangle({x : x, y : y, width : width, height : height}));
  const layouts = settings.get_strv("layouts");
  if (!layouts.length)
    return;
  const layout = Me.imports.layouts[layouts[0]];
  if (!layout)
    return;
  layout(settings, wins, area).forEach((rect, idx) => {
    global.log("LAYOUT: ", rect.height);
    refreshTile(wins[idx], idx, rect);
  });
}

function refresh() {
  Main.layoutManager.monitors.forEach((_, m) => refreshMonitor(m));
}

let _handle_gs;
let _handle_panel_position;
let _handle_wm0;
let _handle_wm1;
let _handle_wm2;
let _handle_wm3;
let _handle_wm4;
let _handle_display0;
let _handle_display1;

function arrayNeighbor(array, el, n) {
  n += array.indexOf(el);
  const len = array.length;
  return n >= len ? array[0] : n < 0 ? array[len - 1] : array[n];
}

function getWorkspaceTiles() {
  return global.workspace_manager.get_active_workspace()
      .list_windows()
      .filter(tileData)
      .sort(tileCompare);
}

function addKeybinding(name, handler) {
  Main.wm.addKeybinding(name, bindings, Meta.KeyBindingFlags.NONE,
                        Shell.ActionMode.NORMAL, handler);
}

function enable() {
  log(`enabling ${Me.metadata.name} version ${Me.metadata.version}`);
  _handle_gs = settings.connect("changed", refresh);
  _handle_panel_position = PanelBox.connect("notify::anchor-y", function() {
    global.log("Notify position", PanelBox.y);
    refresh();
  });
  _handle_wm0 = global.window_manager.connect("map", (_, w) => {
    tileInitAuto(w.meta_window);
    refresh();
  });
  _handle_wm1 = global.window_manager.connect("destroy", refresh);
  _handle_wm2 = global.window_manager.connect("minimize", refresh);
  _handle_wm3 = global.window_manager.connect("unminimize", refresh);
  _handle_wm4 = global.window_manager.connect("switch-workspace", refresh);
  _handle_display0 = global.display.connect("restacked", refresh);
  _handle_display1 = global.display.connect("grab-op-end", (_0, _1, w1, op) => {
    if (op !== Meta.GrabOp.MOVING)
      return;
    const [px, py, pmask] = global.get_pointer();
    for (let m = 0; m < Main.layoutManager.monitors.length; m++) {
      const {x, y, width, height} = Main.layoutManager.monitors[m];
      if (px < x || px > x + width || py < y || py > y + height)
        continue;
      const p =
          new Meta.Rectangle({x : px - x, y : py - y, width : 1, height : 1});
      const w2 =
          getWorkspaceTiles().find(w => w !== w1 && w.get_monitor() === m &&
                                        w.get_frame_rect().intersect(p)[0]);
      if (w2) {
        swapTiles(w1, w2);
        refresh();
        return;
      }
    }
  });
  addKeybinding("toggle-tile", () => {
    const win = global.display.get_focus_window();
    if (!win)
      return;
    if (tileData(win))
      tileDestroy(win);
    else
      tileInit(win);
    refresh();
  });
  addKeybinding("toggle-panel", () => {
    let panel_y = PanelBox.y < 0 ? 0 : -PanelBox.height;
    PanelBox.y = panel_y;
    refresh();
    global.log("Toggle panel to", panel_y);
  });
  addKeybinding("switch-next-layout", () => {
    const layouts = settings.get_strv("layouts");
    layouts.push(layouts.shift());
    settings.set_strv("layouts", layouts);
  });
  addKeybinding("switch-previous-layout", () => {
    const layouts = settings.get_strv("layouts");
    layouts.unshift(layouts.pop());
    settings.set_strv("layouts", layouts);
  });
  addKeybinding("focus-next-tile", () => {
    const w1 = global.display.get_focus_window();
    const w2 = arrayNeighbor(getWorkspaceTiles(), w1, 1);
    if (w2)
      w2.focus(global.get_current_time());
  });
  addKeybinding("focus-previous-tile", () => {
    const w1 = global.display.get_focus_window();
    const w2 = arrayNeighbor(getWorkspaceTiles(), w1, -1);
    if (w2)
      w2.focus(global.get_current_time());
  });
  addKeybinding("focus-first-tile", () => {
    const w2 = getWorkspaceTiles()[0];
    if (w2)
      w2.focus(global.get_current_time());
  });
  addKeybinding("swap-next-tile", () => {
    const w1 = global.display.get_focus_window();
    const w2 = arrayNeighbor(getWorkspaceTiles(), w1, 1);
    if (w1 && w2) {
      swapTiles(w1, w2);
      refresh();
    }
  });
  addKeybinding("swap-previous-tile", () => {
    const w1 = global.display.get_focus_window();
    const w2 = arrayNeighbor(getWorkspaceTiles(), w1, -1);
    if (w1 && w2) {
      swapTiles(w1, w2);
      refresh();
    }
  });
  addKeybinding("swap-first-tile", () => {
    const w1 = global.display.get_focus_window();
    const w2 = getWorkspaceTiles()[0];
    if (w1 && w2) {
      swapTiles(w1, w2);
      refresh();
    }
  });
  addKeybinding("increase-split", () => {
    const r = settings.get_double("split-ratio");
    const s = settings.get_double("split-ratio-step");
    settings.set_double("split-ratio", r + s);
  });
  addKeybinding("decrease-split", () => {
    const r = settings.get_double("split-ratio");
    const s = settings.get_double("split-ratio-step");
    settings.set_double("split-ratio", r - s);
  });
  addKeybinding("increase-master-count",
                () => settings.set_uint("master-count",
                                        settings.get_uint("master-count") + 1));
  addKeybinding("decrease-master-count",
                () => settings.set_uint("master-count",
                                        settings.get_uint("master-count") - 1));
  global.get_window_actors().forEach(w => tileInitAuto(w.meta_window));
  refresh();
}

function disable() {
  PanelBox.y = 0;
  settings.disconnect(_handle_gs);
  PanelBox.disconnect(_handle_panel_position);
  global.display.disconnect(_handle_display0);
  global.display.disconnect(_handle_display1);
  global.window_manager.disconnect(_handle_wm0);
  global.window_manager.disconnect(_handle_wm1);
  global.window_manager.disconnect(_handle_wm2);
  global.window_manager.disconnect(_handle_wm3);
  global.window_manager.disconnect(_handle_wm4);
  Main.wm.removeKeybinding("toggle-tile");
  Main.wm.removeKeybinding("switch-next-layout");
  Main.wm.removeKeybinding("switch-previous-layout");
  Main.wm.removeKeybinding("focus-next-tile");
  Main.wm.removeKeybinding("focus-previous-tile");
  Main.wm.removeKeybinding("focus-first-tile");
  Main.wm.removeKeybinding("swap-next-tile");
  Main.wm.removeKeybinding("swap-previous-tile");
  Main.wm.removeKeybinding("swap-first-tile");
  Main.wm.removeKeybinding("increase-split");
  Main.wm.removeKeybinding("decrease-split");
  Main.wm.removeKeybinding("increase-master-count");
  Main.wm.removeKeybinding("decrease-master-count");
  global.get_window_actors().forEach(w => tileDestroy(w.meta_window));
}
