# box3-ac-patch

本仓库仅供学习、研究参考。是否使用、如何使用均为个人行为，作者不对任何直接或间接损失承担责任。

BOX Local Engine（v0.2.0）反外挂补丁。用 **compose overlay + bind-mount** 盖住镜像里的两个 JS 文件，不改数据卷。

引擎升级会换镜像、覆盖 `compose.yml`，但只要再跑一次 `apply.sh`，补丁会重新挂上去。

## 拦什么

客户端 `input.bodies` 可以提交**别人的刚体**位置。LoliBox KillAura 会改其他玩家的 `px/py/pz` 再打进这个字段，全图人被拽走。

补丁：

1. `net-tick.js`：同伴近距离校正仍按 0.25 权重叠进去（延迟、对向跑步、瞬间穿模容错）。超过约 3 格的拽人包丢掉，且自己的权威校正不会被别人抢走。
2. `net-server-controller.js`：把其他玩家拽走超过约 3 格则踢出。前两次记警告，第三次封 IP。同一连接只计一次，重进再犯才加警告。

不限制自己的移动速度。

日志（容器内 / 宿主机）：

- `/opt/box3-engine/apps/local-engine/data/loki-cheaters.jsonl`
- `/opt/box3-engine/apps/local-engine/data/loki-ban-ips.txt`

## 安装 / 升级引擎后重打

在引擎机上：

```sh
git clone https://github.com/Ink-Stained-Clouds/box3-ac-patch.git
cd box3-ac-patch
chmod +x apply.sh
./apply.sh /opt/box3-engine
```

已经 clone 过的：

```sh
cd box3-ac-patch && git pull && ./apply.sh /opt/box3-engine
```

`apply.sh` 会：

- 把 `files/` 拷到 `$ENGINE_ROOT/patches/`
- 写入 `compose.ac.yml`（不改你的地图/postgres）
- 在 `.env` 里加上 `COMPOSE_FILE=compose.yml:compose.ac.yml`
- `docker compose up -d creator play`

不要用 `docker compose down -v`。

## 引擎大版本升级

镜像里这两个路径如果变了，bind-mount 会挂空：

- `.../@box/schema/build/net/net-tick.js`
- `.../dist/src/net/net-server-controller.js`

这时用 `diffs/` 里的 unified diff 对着新源码重打：

```sh
patch -p1 < diffs/net-tick.js.diff
patch -p1 < diffs/net-server-controller.js.diff
```

冲突就按 `diffs/` 里的逻辑手工移植：只收自己的 body；发现改别人坐标就踢。

## 目录

```
files/     当前可挂载的完整补丁文件（v0.2.0）
diffs/     相对原版的 unified diff，方便移植
compose.ac.yml
apply.sh
```
