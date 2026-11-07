# 对 PvZ-Godot 源码做的改动

本插件不是「不改引擎就能跑」的：为了让游戏能被程序驱动、能按 50 关战役跑、能被规则包覆盖，改了下表这些地方。
**改动以 2025-11 的 `game-a11y/PvZ-Godot` main 为基准**，上游如果更新了，这些位置需要重新对照。

所有 `Bridge.` 开头的调用都来自本仓库的 `bridge/bridge.gd`。

---

## 1. `project.godot`

在 autoload 段加一行（`Bridge` 必须排在 `Global`、`EventBus` 之后）：

```ini
[autoload]
Bridge="*res://scripts/autoload/bridge.gd"
```

Web 版中文显示需要（如果你换了字体）：

```ini
[gui]
theme/custom_font="res://assets/fonts/方正少儿_GBK.ttf"
```

## 2. `scripts/autoload/bridge.gd`（新增文件）

整份拷进去即可。它负责：

- TCP（原生）/ `fetch` + `postMessage`（Web）两种传输；
- 每 100ms 导出局面（阳光、波次、植物、僵尸、推车、卡组、当前关卡…）；
- 执行 `start / restart / plant / shovel / pause / speed / sun / choose / rules / endless / reset / quit / close` 命令；
- 50 关战役表、进度存档、只保留可用行的路数限制、自动续关、无尽模式；
- 胜负事件订阅（`bridge_game_result`）。

## 3. `scripts/manager/main_game_manager.gd`

**失败**：`on_zombie_go_home()` 里，`main_game_progress = E_MainGameProgress.GAME_OVER` 之后加：

```gdscript
EventBus.push_event("bridge_game_result", ["lose"])
```

**胜利**：`create_trophy()` 里 `print("=======游戏结束，您获胜了=======")` 之后加：

```gdscript
EventBus.push_event("bridge_game_result", ["win"])
```

## 4. `scripts/manager/zombie_manager/zm_zombie_wave_manager.gd`

原版把「旗前波 / 旗帜波」硬编码成 `% 10`，我们的关卡是 4/6/16/20 波，会导致进度条回退。
把所有 `curr_wave % 10` 改成 `curr_wave % max_wave_one_round`：

```gdscript
# 旗前波
if max_wave_one_round > 1 and curr_wave % max_wave_one_round == max_wave_one_round - 2:
# 旗帜波
elif curr_wave % max_wave_one_round == max_wave_one_round - 1:
```

另外 `set_progress_bar(int(curr_wave % max_wave_one_round / 10.0))` 的入参是「第几面旗」，改成不带参数的 `set_progress_bar()`（由进度条自己用 `progress_bar_segment_every_wave` 算）。

## 5. `scripts/ui/main_game_ui/ui_flag_progress_bar.gd`

- 删掉 `init_flag_from_wave()` 里的 `assert(wave_num % 10 == 0, "当前波数不为10的倍数")`；
- `flag_num` 改成 `max(1, int(ceil(wave_num / 10.0)))`（4 波关也要有 1 面旗）。

## 6. `scripts/manager/zombie_manager/zombie_manager.gd`

`create_norm_zombie()` 里，在 `all_zombies_2d[zombie.lane].append(zombie)` 之前加血量倍率：

```gdscript
var hp_scale := Bridge.rule_f("zombieHpScale")
if not is_equal_approx(hp_scale, 1.0):
    var hpc = zombie.hp_component
    if hpc != null:
        if hpc.max_hp > 0:
            hpc.max_hp = max(1, int(round(float(hpc.max_hp) * hp_scale)))
            hpc.curr_hp = hpc.max_hp
        # max_hp_armor1 / max_hp_armor2 同理
```

## 7. `scripts/character/character_000_base.gd`

`init_random_speed()` 里给速度叠倍率：

```gdscript
var spd := randf_range(random_speed_range.x, random_speed_range.y)
if Bridge != null:
    spd *= Bridge.rule_f("zombieSpeedScale")
update_speed_factor(spd, E_Influence_Speed_Factor.InitRandomSpeed)
```

## 8. `scripts/manager/zombie_manager/zm_zombie_choose_row_system.gd`

`calculate_smooth_weights()` 里，落在本关不可用行的权重置 0：

```gdscript
var allowed_rows_arr: Array = Bridge.allowed_rows()
...
if not allowed_rows_arr.has(i):
    smooth_weights.append(0.0)
    continue
```

## 9. `scripts/ui/start_menu/start_menu_root.gd`

- 「开始冒险」按钮 → `Bridge.start_campaign()`（跳过九宫格演示页，直接进战役第 N 关）；
- 「退出」在 Web 下改成弹提示（Web 版 `get_tree().quit()` 会冻住主循环）：

```gdscript
if OS.has_feature("web"):
    # 弹 dialog，不要 quit
else:
    get_tree().quit()
```

- `_ready()` 末尾隐藏这些空壳入口（`visible=false` + `mouse_filter=IGNORE`）：
  - `BG_Right/Item/TextureButton`（花园）
  - `BG_Right/Item/TextureButton2`（图鉴）
  - `BG_Right/Item/TextureButton3`（商店）
  - `BG_Right/Option/TextureButton2`（帮助）
  - `BG_Right/Option/TextureButton3`（退出）

## 10. 字体（Web 版中文）

原仓库的 `assets/fonts/Bake_Soda.otf` 和 `方正少儿_GBK.ttf` 是 773,236 字节的 Arial 占位文件，浏览器里所有中文都是豆腐块。
把任意含 CJK 的字体（我们用的是 macOS 的 `Arial Unicode.ttf`）复制成这两个文件名，并把三处 `SystemFont` 子资源换成它：

- `scenes/ui/all_cards/card_base.tscn`
- `scenes/main/02AdventureChooesLevel.tscn`
- `scenes/main/03MiniGameChooesLevel.tscn`

## 11. 数据文件

- `campaign/adventure.json`：50 关战役表（来自 PvZ-Portable 的 `gZombieWaves` / `gZombieAllowedLevels` / `GetAwardSeedForLevel`）。
- `rules/classic.json`、`rules/v95.json`：规则包（血量/速度/波数/初始阳光倍率）。
- `export_presets.cfg`：Web 导出预设（`thread_support=false`、`canvas_resize_policy=2`）。

## 12. 数据热更新

`campaign` 数据由 host 每次 `start` 时随指令下发（`{"cmd":"start","campaign":"<json>"}`），**改关卡表不需要重新导出 pck**，刷新页面即可。
