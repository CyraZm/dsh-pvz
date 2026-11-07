extends Node
## PvZ ⇄ DSH bridge (autoload "Bridge").
## Transport: plain TCP on 127.0.0.1:37916, newline-delimited JSON (NDJSON).
## Out: {"type":"state", ...} at 10 Hz, {"type":"ack","id":n,"ok":bool,"err":str}
## In : {"id":n,"cmd":"plant","r":0,"c":0,"type":1} ...

const PORT := 37916
const STATE_INTERVAL := 0.1

var _web := false
var _srv := TCPServer.new()
var _peer: StreamPeerTCP = null
var _rx := ""
var _acc := 0.0
var _result := ""
var auto_next := true
var _win_at_ms := 0
var _endless := false
var _level_name := ""
var _tick := 0
## 每个页面实例一个 id：插件可能被多个标签页同时打开，宿主只认最新的那个
var _inst := ""
var _cmd_cb: JavaScriptObject = null

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_inst = "%d-%d" % [Time.get_ticks_usec(), randi() % 100000]
	_web = OS.has_feature("web")
	if _web:
		_setup_web()
	else:
		var err := _srv.listen(PORT, "127.0.0.1")
		print("[BRIDGE] listening on 127.0.0.1:%d (err=%d)" % [PORT, err])
	EventBus.subscribe("bridge_game_result", func(r):
		_result = str(r)
		if _result == "win" and not _endless and _campaign_idx >= 0 and _campaign_idx + 1 > progress:
			progress = _campaign_idx + 1
			save_progress()
			print("[BRIDGE] progress=", progress)
		if _result == "win":
			_win_at_ms = Time.get_ticks_msec()
	)
	if not _web:
		_setup_window()
	## 首次启动（尤其 Web 的新 origin）自动建一个用户，避免卡在"请输入名字"对话框
	if rules.is_empty():
		load_rules("v95")
	if campaign.is_empty():
		load_campaign()
	load_progress()
	if Global.all_user_name.is_empty():
		Global.add_user("玩家")
		Global.switch_user("玩家")

## Web build: talk to the embedding page through postMessage.
func _setup_web() -> void:
	var window = JavaScriptBridge.get_interface("window")
	# 必须留一个 GDScript 侧引用，否则回调会被 GC，JS 调用直接沉默失败
	_cmd_cb = JavaScriptBridge.create_callback(_on_web_cmd)
	window.__pvzOnCmd = _cmd_cb
	JavaScriptBridge.eval("""
		window.__pvzEmit = window.__pvzEmit || function (json) {
			try {
				window.parent.postMessage({ source: 'dsh-pvz', kind: 'state', data: JSON.parse(json) }, '*');
			} catch (e) {}
			try {
				fetch('/dsh-pvz/tick', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: json
				}).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
					if (!d || !d.cmds) return;
					for (var i = 0; i < d.cmds.length; i++) {
						try { window.__pvzOnCmd(JSON.stringify(d.cmds[i])); } catch (e) {}
					}
				}).catch(function () {});
			} catch (e) {}
		};
		window.__pvzReply = window.__pvzReply || function (json) {
			try { window.parent.postMessage({ source: 'dsh-pvz', kind: 'ack', data: JSON.parse(json) }, '*'); } catch (e) {}
			try {
				fetch('/dsh-pvz/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: json }).catch(function () {});
			} catch (e) {}
		};
		window.addEventListener('message', function (e) {
			var d = e.data;
			if (!d || d.source !== 'dsh-pvz-host' || d.kind !== 'cmd') return;
			try { window.__pvzOnCmd && window.__pvzOnCmd(JSON.stringify(d.cmd)); } catch (err) {}
		});
	""", true)
	print("[BRIDGE] web transport ready")

func _on_web_cmd(args: Array) -> void:
	if args.size() < 1:
		return
	_handle_line(str(args[0]))

## 摸鱼模式：置顶 + 缩小到右下角（保留系统标题栏，方便拖动/关闭/收起）
func _setup_window() -> void:
	if _web or DisplayServer.get_name() == "headless":
		return
	var win := get_window()
	win.always_on_top = true
	win.size = Vector2i(640, 360)
	var usable: Rect2i = DisplayServer.screen_get_usable_rect(DisplayServer.window_get_current_screen())
	win.position = usable.position + Vector2i(usable.size.x - 640 - 24, usable.size.y - 360 - 80)

func _process(delta: float) -> void:
	if not _web:
		_accept()
	if _peer != null and _peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		print("[BRIDGE] peer closed")
		_peer = null
		_rx = ""
	if not _web:
		_poll()
	## 每帧兜底：有游戏时强制开启阳光自动收集（Global 会在切场景时重载配置）
	if _game() != null:
		Global.auto_collect_sun = true
		var mm = _game()
		var gid: int = mm.get_instance_id()
		## 可用行数（1/3/5/6 路）在每局开始时应用一次
		if _lanes_for_id != gid and mm.plant_cell_manager != null:
			_apply_lanes(_lanes)
		## 通关 5 秒后自动进下一关
		if _win_at_ms > 0 and auto_next and Time.get_ticks_msec() - _win_at_ms > 5000:
			_win_at_ms = 0
			if not _endless and progress < campaign.size():
				_result = ""
				var nerr := _cmd_start("")
				if nerr != "":
					print("[BRIDGE] auto next failed: ", nerr)
	_acc += delta
	if _acc >= STATE_INTERVAL:
		_acc = 0.0
		_send_state()

func _accept() -> void:
	while _srv.is_connection_available():
		var p := _srv.take_connection()
		if _peer != null:
			p.disconnect_from_host()
		else:
			_peer = p
			_rx = ""
			print("[BRIDGE] peer connected")

func _poll() -> void:
	if _peer == null:
		return
	var n := _peer.get_available_bytes()
	if n <= 0:
		return
	var chunk := _peer.get_utf8_string(n)
	_rx += chunk
	while true:
		var idx := _rx.find("\n")
		if idx < 0:
			break
		var line := _rx.substr(0, idx).strip_edges()
		_rx = _rx.substr(idx + 1)
		if line != "":
			_handle_line(line)

func _send(obj: Dictionary) -> void:
	if _web:
		var js := JSON.stringify(JSON.stringify(obj))
		var fn := "__pvzEmit" if obj.get("type", "") == "state" else "__pvzReply"
		JavaScriptBridge.eval("window.%s && window.%s(%s);" % [fn, fn, js], true)
		return
	if _peer == null:
		return
	_peer.put_data((JSON.stringify(obj) + "\n").to_utf8_buffer())

#region state

func _game():
	var g = Global.main_game
	if g == null or not is_instance_valid(g):
		return null
	return g

func _process_mode_name(g) -> int:
	return int(g.main_game_progress)

func _sun() -> int:
	var g = _game()
	if g == null:
		return 0
	var cm = g.card_manager
	if cm == null or not is_instance_valid(cm):
		return 0
	var slot = cm.get("card_slot_battle")
	if slot == null or not is_instance_valid(slot):
		return 0
	return int(slot.sun_value)

func _send_state() -> void:
	_tick += 1
	var g = _game()
	var out := {"type": "state", "tick": _tick, "game": g != null, "inst": _inst}
	if g != null:
		out["sun"] = _sun()
		out["progress"] = _process_mode_name(g)
		out["paused"] = get_tree().paused
		out["speed"] = Engine.time_scale
		out["result"] = _result
		out["level"] = _level_name
		out["rules"] = rules_id
		out["endless"] = _endless
		out["auto_next"] = auto_next
		var lv := _campaign_level(_campaign_idx)
		out["campaign"] = {
			"idx": _campaign_idx,
			"name": str(lv.get("name", "")),
			"world": str(lv.get("world", "")),
			"done": progress,
			"total": campaign.size(),
		}
		var gd = Global.game_para
		if gd != null:
			out["deck"] = _deck_of(gd)
		out["lanes"] = _lanes
		out["pool"] = _pool
		out["sel_n"] = Global.selected_cards.size() if Global.selected_cards != null else -1
		var _mm2 = _game()
		if _mm2 != null and _mm2.card_manager != null and _mm2.card_manager.card_slot_battle != null:
			out["battle_n"] = _mm2.card_manager.card_slot_battle.curr_cards.size()
		else:
			out["battle_n"] = -1
		out["slots"] = _slots
		out["choosing"] = int(out.get("progress", 0)) == 1
		var cd := chosen_deck()
		out["deck"] = cd if cd.size() > 0 else _pool
		out["rows_allowed"] = _allowed_rows()
		var pcm = g.plant_cell_manager
		var zmg = g.zombie_manager
		var lmm = g.lawn_mover_manager
		var rows := 0
		var cols := 0
		if pcm != null and is_instance_valid(pcm):
			var rc: Vector2i = pcm.row_col
			rows = rc.x
			cols = rc.y
		out["rows"] = rows
		out["cols"] = cols
		## wave
		if zmg != null and is_instance_valid(zmg):
			var wm = zmg.get("zombie_wave_manager")
			if wm != null and is_instance_valid(wm):
				out["wave"] = int(wm.curr_wave)
				out["max_wave"] = int(wm.max_wave)
			out["zombie_count"] = zmg.curr_zombie_num
		## plants
		var plants := []
		if pcm != null and is_instance_valid(pcm) and rows > 0:
			var cells = pcm.all_plant_cells
			for r in range(rows):
				var row = cells[r]
				for c in range(cols):
					var cell = row[c]
					for slot_key in cell.plant_in_cell.keys():
						var p = cell.plant_in_cell[slot_key]
						if p != null and is_instance_valid(p):
							plants.append({
								"r": r,
								"c": c,
								"slot": int(slot_key),
								"type": int(p.plant_type),
								"hp": _hp_of(p),
							})
		out["plants"] = plants
		## zombies
		var zombies := []
		if zmg != null and is_instance_valid(zmg):
			for z in zmg.all_zombies_1d:
				if z != null and is_instance_valid(z):
					zombies.append({
						"id": int(z.get_instance_id()),
						"r": int(z.lane),
						"x": z.global_position.x,
						"type": int(z.zombie_type),
						"hp": _hp_of(z),
					})
		out["zombies"] = zombies
		## lawn mowers
		var mowers := []
		if lmm != null and is_instance_valid(lmm):
			for m in lmm.all_lawn_movers:
				if m != null and is_instance_valid(m):
					mowers.append({"r": int(m.lane), "moving": bool(m.is_moving)})
		out["mowers"] = mowers
		out["auto_sun"] = Global.auto_collect_sun
		var suns_node = g.get("suns")
		out["sun_nodes"] = suns_node.get_child_count() if suns_node != null else -1
		## board geometry (global x of first/last column center)
		if rows > 0 and cols > 0 and pcm != null and is_instance_valid(pcm):
			var c0 = pcm.all_plant_cells[0][0]
			var cn = pcm.all_plant_cells[0][cols - 1]
			out["x0"] = c0.global_position.x
			out["x1"] = cn.global_position.x
	_send(out)

func _hp_of(node) -> int:
	var hp = node.get("hp_component")
	if hp != null and is_instance_valid(hp):
		return int(hp.curr_hp)
	return -1

#endregion

#region commands

func _handle_line(line: String) -> void:
	var parsed = JSON.parse_string(line)
	if typeof(parsed) != TYPE_DICTIONARY:
		return
	var req: Dictionary = parsed
	var id = req.get("id", 0)
	var cmd := str(req.get("cmd", ""))
	var err := ""
	match cmd:
		"ping":
			err = ""
		"start":
			if req.has("campaign"):
				var cj = JSON.parse_string(str(req["campaign"]))
				if typeof(cj) == TYPE_DICTIONARY and cj.has("levels"):
					campaign = cj["levels"]
			auto_choose = bool(req.get("auto", false))
			if req.has("progress"):
				progress = max(0, int(req["progress"]))
				save_progress()
			err = _cmd_start(str(req.get("level", "")))
		"endless":
			err = _cmd_start("endless")
		"restart":
			_result = ""
			get_tree().reload_current_scene()
		"plant":
			err = _cmd_plant(int(req.get("r", -1)), int(req.get("c", -1)), int(req.get("type", 0)))
		"choose":
			err = _cmd_choose(req.get("deck", []))
		"shovel":
			err = _cmd_shovel(int(req.get("r", -1)), int(req.get("c", -1)))
		"pause":
			_cmd_pause(bool(req.get("on", true)))
		"speed":
			Engine.time_scale = clampf(float(req.get("v", 1.0)), 0.05, 8.0)
		"sun":
			EventBus.push_event("add_sun_value", [int(req.get("v", 0))])
		"rules":
			if not load_rules(str(req.get("id", "classic"))):
				err = "unknown rules pack"
		"reset":
			progress = 0
			_campaign_idx = 0
			save_progress()
		"quit":
			if not OS.has_feature("web"):
				get_tree().quit()
		_:
			err = "unknown cmd: " + cmd
	_send({"type": "ack", "id": id, "ok": err == "", "err": err})

## 限制出怪与种植的行（原版 1-1 只有 1 路，1-2/1-3 为 3 路）
func _row_total() -> int:
	var mm = _game()
	if mm != null and mm.plant_cell_manager != null and mm.plant_cell_manager.all_plant_cells != null:
		var n: int = mm.plant_cell_manager.all_plant_cells.size()
		if n > 0:
			return n
	return 5


func _allowed_rows() -> Array:
	var total := _row_total()
	if _lanes >= total:
		var all: Array = []
		for i in range(total):
			all.append(i)
		return all
	if _lanes == 3 and total >= 5:
		return [1, 2, 3]
	if _lanes == 3:
		return [0, 1, 2]
	if _lanes == 2 and total >= 5:
		return [1, 2]
	if _lanes == 2:
		return [0, 1]
	if total >= 5:
		return [2]
	return [total / 2]

func allowed_rows() -> Array:
	return _allowed_rows()

func _apply_lanes(n: int) -> void:
	var mm = _game()
	if mm == null:
		return
	var allowed := _allowed_rows()
	if _lanes >= _row_total():
		_lanes_applied = true
		_lanes_for_id = mm.get_instance_id()
		return
	## 视觉：只保留可用的行与割草机
	var pcm = mm.plant_cell_manager
	if pcm != null and pcm.plant_cells_root != null:
		for i in range(pcm.plant_cells_root.get_child_count()):
			pcm.plant_cells_root.get_child(i).visible = allowed.has(i)
	var lmm = mm.lawn_mover_manager
	if lmm != null and lmm.all_lawn_movers != null:
		for i in range(lmm.all_lawn_movers.size()):
			var mv = lmm.all_lawn_movers[i]
			if mv != null and is_instance_valid(mv):
				mv.visible = allowed.has(i)
	## 出怪行权重
	var zm = mm.zombie_manager
	if zm == null or zm.zombie_wave_manager == null:
		return
	var zc = zm.zombie_wave_manager.zombie_choose_row_system
	if zc == null:
		return
	for t in zc.base_weigth_all_type.keys():
		var arr = zc.base_weigth_all_type[t]
		for i in range(arr.size()):
			arr[i] = 1.0 if allowed.has(i) else 0.0
		zc.base_weigth_all_type[t] = arr
	_lanes_applied = true
	_lanes_for_id = mm.get_instance_id()

## ---------- 战役（50 关） ----------
const CAMPAIGN_PATH := "res://campaign/adventure.json"
const PROGRESS_PATH := "user://pvz_progress.json"
const WORLD_SCENES := [
	"res://resources/level_date_resource/mode_adventure/adventure_01_day.tres",
	"res://resources/level_date_resource/mode_adventure/adventure_02_night.tres",
	"res://resources/level_date_resource/mode_adventure/adventure_03_pool.tres",
	"res://resources/level_date_resource/mode_adventure/adventure_04_fog.tres",
	"res://resources/level_date_resource/mode_adventure/adventure_05_Roof.tres",
]
var campaign: Array = []
var progress: int = 0
var _campaign_idx: int = -1
var _lanes: int = 5
var _pool: Array = []
var _slots: int = 0
var auto_choose: bool = false
var _lanes_applied: bool = false
var _bank_cleared_for: int = 0
var _lanes_for_id: int = 0

func load_campaign() -> void:
	if not FileAccess.file_exists(CAMPAIGN_PATH):
		print("[BRIDGE] campaign missing")
		return
	var data = JSON.parse_string(FileAccess.get_file_as_string(CAMPAIGN_PATH))
	if typeof(data) == TYPE_DICTIONARY and data.has("levels"):
		campaign = data["levels"]
	print("[BRIDGE] campaign levels=", campaign.size())

func load_progress() -> void:
	if not FileAccess.file_exists(PROGRESS_PATH):
		return
	var data = JSON.parse_string(FileAccess.get_file_as_string(PROGRESS_PATH))
	if typeof(data) == TYPE_DICTIONARY:
		progress = int(data.get("done", 0))

func save_progress() -> void:
	var f := FileAccess.open(PROGRESS_PATH, FileAccess.WRITE)
	if f == null:
		return
	f.store_string(JSON.stringify({"done": progress}))
	f.close()

func _campaign_level(idx: int) -> Dictionary:
	if idx < 0 or idx >= campaign.size():
		return {}
	return campaign[idx]

## 用战役数据生成这一关的 ResourceLevelData（复制世界模板再覆盖）
func _campaign_res(idx: int) -> ResourceLevelData:
	var lv := _campaign_level(idx)
	if lv.is_empty():
		return null
	var wi := int(lv.get("tpl", lv.get("scene", 0)))
	var tpl_path: String = WORLD_SCENES[clampi(wi, 0, WORLD_SCENES.size() - 1)]
	var tpl = load(tpl_path)
	if tpl == null:
		return null
	var res: ResourceLevelData = tpl.duplicate(true)
	res.level_name = "%s %s" % [lv.get("name", ""), lv.get("world", "")]
	res.game_sences = int(lv.get("scene", 0)) as Global.MainScenes
	res.game_BG = int(lv.get("bg", 0))
	res.game_BGM = int(lv.get("bgm", 0))
	res.is_day = bool(lv.get("is_day", true))
	res.is_day_sun = bool(lv.get("is_day_sun", true))
	res.is_fog = bool(lv.get("fog", false))
	res.is_have_tombston = bool(lv.get("tomb", false))
	if lv.has("tomb_num"):
		res.init_tombstone_num = int(lv["tomb_num"])
	res.max_wave = int(lv.get("waves", 10))
	res.start_sun = int(lv.get("sun", 50))
	var deck: Array[Global.PlantType] = []
	for t in lv.get("deck", []):
		deck.append(int(t) as Global.PlantType)
	res.pre_choosed_card_list_plant = deck
	res.max_choosed_card_num = deck.size()
	var zs: Array[Global.ZombieType] = []
	for z in lv.get("zombies", []):
		zs.append(int(z) as Global.ZombieType)
	if not zs.is_empty():
		res.zombie_refresh_types = zs
	res.set_meta("src_path", "%s#%d" % [tpl_path, idx])
	res.set_meta("lanes", int(lv.get("rows", 5)))
	res.set_meta("slots", int(lv.get("slots", 6)))
	return res

## ---------- 规则包 ----------
const RULES_DIR := "res://rules"
var rules: Dictionary = {}
var rules_id: String = "classic"

func load_rules(id: String) -> bool:
	var path := "%s/%s.json" % [RULES_DIR, id]
	if not FileAccess.file_exists(path):
		return false
	var txt := FileAccess.get_file_as_string(path)
	var data = JSON.parse_string(txt)
	if typeof(data) != TYPE_DICTIONARY:
		return false
	rules = data
	rules_id = id
	print("[BRIDGE] rules=", id, " ", data.get("name", ""))
	return true

func rule_f(key: String, def: float = 1.0) -> float:
	if rules.has(key):
		return float(rules[key])
	return def

const ADVENTURE_SCENE := "res://scenes/main/02AdventureChooesLevel.tscn"
## 各世界的默认卡组（关卡 .tres 里没写 pre_choosed_card_list_plant 时用它）
## 对应原版：1-1 只有豌豆射手，之后逐关解锁向日葵/坚果/土豆雷/樱桃
const DEFAULT_DECKS := {
	"adventure_01_day": [1],
	"adventure_02_night": [1, 2],
	"adventure_03_pool": [1, 2, 4, 6],
	"adventure_04_fog": [1, 2, 4, 5, 6],
	"adventure_05_Roof": [1, 2, 3, 4, 5, 6],
}

func _deck_of(res) -> Array:
	if str(res.get_meta("src_path", "")) == "endless":
		return _endless_deck()
	var deck: Array = []
	if res != null and res.pre_choosed_card_list_plant != null and res.pre_choosed_card_list_plant.size() > 0:
		for t in res.pre_choosed_card_list_plant:
			deck.append(int(t))
		return deck
	var base := ""
	if res != null:
		base = str(res.get_meta("src_path", res.resource_path)).get_file().get_basename()
	if DEFAULT_DECKS.has(base):
		return DEFAULT_DECKS[base].duplicate()
	return [1, 2]

## 按原版选关逻辑，找出"第一个还没通关的冒险关卡"
func _next_adventure_level() -> Dictionary:
	var packed: PackedScene = load(ADVENTURE_SCENE)
	if packed == null:
		return {}
	var root = packed.instantiate()
	var all_page = root.get_node_or_null("AllPage")
	if all_page == null:
		root.free()
		return {}
	var counter := 1
	var chosen := {}
	for page_i in all_page.get_child_count():
		var page = all_page.get_child(page_i)
		for node in page.get_children():
			if not (node is ChooseLevelButton):
				continue
			var id_str := "%04d" % counter
			counter += 1
			var data = node.curr_level_data_game_para
			if data == null:
				continue
			if data.game_round == -1:
				continue
			var path: String = data.resource_path
			if path == "":
				continue
			var copy = data.duplicate(true)
			copy.set_meta("src_path", path)
			copy.set_choose_level(Global.MainScenes.ChooseLevelAdventure, page_i, id_str)
			var st: Dictionary = Global.curr_all_level_state_data.get(copy.save_game_name, {})
			if st.get("IsSuccess", false):
				continue
			chosen = {"res": copy, "path": path, "name": copy.save_game_name, "id": id_str}
			break
		if not chosen.is_empty():
			break
	root.free()
	return chosen

## 给游戏内菜单调用：直接开当前战役关
func start_campaign() -> String:
	return _cmd_start("")


## 无尽模式：全部植物可选、10 个卡槽、波次不封顶
func _build_endless_res() -> ResourceLevelData:
	var tpl_path := "res://resources/level_date_resource/mode_adventure/adventure_01_day.tres"
	var tpl = load(tpl_path)
	if tpl == null:
		return null
	var res = tpl.duplicate(true)
	res.level_name = "endless"
	res.save_game_name = "endless"
	res.game_sences = Global.MainScenes.MainGameFront
	res.look_show_zombie = false
	res.can_choosed_card = false
	res.crazy_dave_dialog = null
	res.max_wave = 9999
	res.start_sun = 150
	res.is_lawn_mover = true
	var all_plants := []
	for t in range(1, 40):
		all_plants.append(t)
	res.set_meta("pool", all_plants)
	res.set_meta("slots", 10)
	res.set_meta("lanes", 5)
	res.pre_choosed_card_list_plant = _endless_deck()
	res.max_choosed_card_num = 10
	res.zombie_refresh_types = [
		Global.ZombieType.Z001Norm, Global.ZombieType.Z003Cone, Global.ZombieType.Z005Bucket,
		Global.ZombieType.Z004PoleVaulter, Global.ZombieType.Z008Football, Global.ZombieType.Z023Catapult,
		Global.ZombieType.Z019Pogo, Global.ZombieType.Z024Gargantuar, Global.ZombieType.Z009Jackson,
	]
	res.set_meta("src_path", "endless")
	return res

## 无尽模式下 AI 用的默认 10 张
func _endless_deck() -> Array:
	return [2, 1, 8, 6, 4, 24, 3, 21, 5, 15]

func _cmd_start(level_path: String) -> String:
	var res = null
	var idx := -1
	if level_path == "endless":
		res = _build_endless_res()
		_endless = true
		_level_name = "无尽模式"
	elif level_path.begins_with("i:"):
		# 战役关卡：i:12 → 第 12 关
		idx = int(level_path.substr(2)) - 1  # i:N 是 1-based 关卡号
	elif level_path == "":
		idx = progress
	elif level_path.begins_with("res://"):
		res = load(level_path)
	if res == null:
		if idx < 0:
			idx = progress
		if idx >= campaign.size():
			return "campaign finished (%d/%d)" % [progress, campaign.size()]
		res = _campaign_res(idx)
		if res == null:
			return "cannot build campaign level %d" % (idx + 1)
		_campaign_idx = idx
		_level_name = str(_campaign_level(idx).get("name", str(idx + 1)))
		level_path = "%s#%d" % [CAMPAIGN_PATH, idx]
	if res == null:
		return "cannot load " + level_path
	if not (res is ResourceLevelData):
		return "not ResourceLevelData"
	if _level_name == "":
		_level_name = str(res.save_game_name)
	_lanes = int(res.get_meta("lanes", 5))
	_lanes_applied = false
	res.crazy_dave_dialog = null
	## 卡组：关卡自带就用关卡自带的，否则按世界给默认（AI 只能种卡组里的植物）
	var deck_ints: Array = _deck_of(res)
	var deck: Array[Global.PlantType] = []
	for t in deck_ints:
		deck.append(t as Global.PlantType)
	## 选卡：给玩家选（可选项 = 本关可用植物，卡槽数 = 本关卡位数）
	var meta_pool = res.get_meta("pool", [])
	if meta_pool is Array and meta_pool.size() > 0:
		_pool = []
		for t in meta_pool:
			_pool.append(int(t))
	else:
		_pool = []
		for t in deck_ints:
			_pool.append(int(t))
	_slots = int(res.get_meta("slots", deck_ints.size()))
	res.max_choosed_card_num = _slots
	if auto_choose:
		res.look_show_zombie = false
		res.can_choosed_card = false
		res.pre_choosed_card_list_plant = deck
	else:
		## 走原版选卡流程（需要 look_show_zombie 才能进选卡分支）
		Global.curr_plant = _pool
		res.look_show_zombie = true
		res.can_choosed_card = true
		res.pre_choosed_card_list_plant = deck.slice(max(0, deck.size() - _slots), deck.size())
	res.start_sun = int(round(float(res.start_sun) * rule_f("startSunScale")))
	if res.max_wave > 0:
		res.max_wave = max(3, int(round(float(res.max_wave) * rule_f("wavesScale"))))
	Global.game_para = res
	## 让阳光自动收集，AI 不需要点阳光
	Global.auto_collect_sun = true
	Global.end_tree_pause_clear_all_pause_factors()
	Engine.time_scale = 1.0
	_result = ""
	var scene_path: String = Global.MainScenesMap[res.game_sences]
	print("[BRIDGE] start level %s -> %s" % [level_path, scene_path])
	get_tree().change_scene_to_file(scene_path)
	return ""

## 玩家在选卡界面当前已选的植物
func chosen_deck() -> Array:
	var out: Array = []
	## 玩家点「一起摇滚吧」时引擎会把选中的卡写进 Global.selected_cards
	if Global.selected_cards != null:
		for d in Global.selected_cards:
			if typeof(d) == TYPE_DICTIONARY and d.has("plant_type"):
				out.append(int(d["plant_type"]))
		if out.size() > 0:
			return out
	var mm = _game()
	if mm == null or mm.card_manager == null:
		return out
	var battle = mm.card_manager.card_slot_battle
	if battle == null or battle.curr_cards == null:
		return out
	for c in battle.curr_cards:
		if c != null and int(c.card_plant_type) > 0:
			out.append(int(c.card_plant_type))
	return out


## 本关真正能种的植物（玩家选完就用选好的，否则用关卡池）
func allowed_plants() -> Array:
	var d := chosen_deck()
	if d.size() > 0:
		return d
	return _pool


## 按给定列表自动选卡并开始
func _cmd_choose(list: Array) -> String:
	var mm = _game()
	if mm == null or mm.card_manager == null:
		return "no game"
	var norm = mm.card_manager.card_slot_norm
	if norm == null:
		return "no card slot"
	var cand = norm.card_slot_candidate
	if cand == null:
		return "no candidate"
	## 以这次选择为准（同时满足引擎的「重选上次卡片」）
	if Global.selected_cards == null:
		Global.selected_cards = []
	Global.selected_cards.clear()
	for t in list:
		Global.selected_cards.append({"plant_type": int(t)})
	if norm.has_method("_on_cancal_card_button_pressed"):
		norm._on_cancal_card_button_pressed()
	var picked := 0
	for t in list:
		var tid := int(t)
		if not AllCards.plant_card_ids.has(tid):
			continue
		var key = AllCards.plant_card_ids[tid]
		if not cand.all_card_candidate_containers_plant.has(key):
			continue
		var cont = cand.all_card_candidate_containers_plant[key]
		if cont != null and cont.card != null:
			cont.card._on_button_pressed()
			picked += 1
	EventBus.push_event("card_slot_norm_start_game")
	return "" if picked > 0 else "nothing picked"


func _cell(r: int, c: int):
	var g = _game()
	if g == null:
		return null
	var pcm = g.plant_cell_manager
	if pcm == null or not is_instance_valid(pcm):
		return null
	var cells = pcm.all_plant_cells
	if r < 0 or r >= cells.size():
		return null
	if c < 0 or c >= cells[r].size():
		return null
	return cells[r][c]

func _cmd_plant(r: int, c: int, plant_type: int) -> String:
	if not _allowed_rows().has(r):
		return "本关只有 %d 路（可用行：%s）" % [_lanes, str(_allowed_rows())]
	var g = _game()
	if g == null:
		return "no game"
	var cell = _cell(r, c)
	if cell == null:
		return "bad cell %d,%d" % [r, c]
	var t := plant_type as Global.PlantType
	var deck: Array = allowed_plants()
	if not deck.is_empty() and not (int(plant_type) in deck):
		return "植物 %d 不在本关卡组里（可用：%s）" % [plant_type, str(deck)]
	var cond = Global.get_plant_info(t, Global.PlantInfoAttribute.PlantConditionResource)
	if cond == null:
		return "unknown plant type %d" % plant_type
	if not cond.judge_is_can_plant(cell, t):
		return "cannot plant here (terrain/occupied/special)"
	var cost := int(Global.get_plant_info(t, Global.PlantInfoAttribute.SunCost))
	if _sun() < cost:
		return "not enough sun (%d < %d)" % [_sun(), cost]
	var plant = cell.create_plant(t)
	if plant == null:
		return "create_plant failed"
	EventBus.push_event("add_sun_value", [-cost])
	return ""

func _cmd_shovel(r: int, c: int) -> String:
	var cell = _cell(r, c)
	if cell == null:
		return "bad cell %d,%d" % [r, c]
	for slot_key in cell.plant_in_cell.keys():
		var p = cell.plant_in_cell[slot_key]
		if p != null and is_instance_valid(p):
			p.be_shovel_kill()
			return ""
	return "no plant"

func _cmd_pause(on: bool) -> void:
	if on:
		Global.start_tree_pause(Global.E_PauseFactor.Menu)
	else:
		Global.end_tree_pause(Global.E_PauseFactor.Menu)
