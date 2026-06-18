# Token 用量查询平台

基于 [new-api](https://github.com/Calcium-Ion/new-api) 的 MySQL 日志数据库，统计指定 API Key 的 token 使用量及费用。前后端打包为单一容器，通过 Docker Compose 一键部署。

## 功能

- **API Key 筛选**：按 `token_name` 多选筛选，支持查询全部
- **时间维度**：今日 / 本周 / 本月 / 近30天 / 所有时间 / 自定义时间范围
- **模型汇总**：按模型统计请求数、输入/输出/缓存 token、费用（USD/CNY）
- **每日明细**：查看每天每个 Key 每个模型的使用明细
- **价格配置**：自定义模型单价（支持 USD/CNY 切换、模型别名映射、汇率设置）
- **缓存读计费**：支持缓存命中 token 按独立价格计费（避免与输入 token 双重计费）
- **导出 Excel**：含「模型汇总」和「每日明细」两个 Sheet，带小计/合计行

## 技术栈

- **后端**：Go 1.22 + Gin + GORM + MySQL
- **前端**：React 18 + TypeScript + Vite + Ant Design 6
- **部署**：Docker 多阶段构建，单容器运行

## 项目结构

```
.
├── backend/          # Go 后端
│   ├── config/       # 环境变量配置
│   ├── db/           # 数据库连接与查询
│   ├── handlers/     # HTTP 接口
│   ├── models/       # 数据模型
│   ├── pricing/      # 价格计算逻辑
│   └── main.go       # 入口（嵌入前端静态资源）
├── frontend/         # React 前端
│   ├── src/pages/    # Dashboard / PriceConfig
│   └── ...
├── Dockerfile        # 多阶段构建
├── docker-compose.yml
└── data/             # 价格配置持久化目录（prices.json）
```

## 部署（Docker Compose）

```bash
# 1. 复制并填写环境变量
cp .env.example .env
# 编辑 .env，填入 new-api 的数据库连接信息

# 2. 构建并启动
docker compose up -d --build

# 3. 访问 http://localhost:8080
```

> 提示：若 MySQL 运行在宿主机（非容器网络），需确保容器能访问到宿主机 IP。可将 `DB_HOST` 设为宿主机内网 IP，或取消注释 `docker-compose.yml` 中的 `extra_hosts` 使用 `host.docker.internal`。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DB_HOST` | `127.0.0.1` | MySQL 地址 |
| `DB_PORT` | `3306` | MySQL 端口 |
| `DB_USER` | `root` | 数据库用户名 |
| `DB_PASSWORD` | _(必填)_ | 数据库密码 |
| `DB_NAME` | `new-api` | 数据库名 |
| `DB_TABLE_NAME` | `logs` | 日志表名 |
| `PORT` | `8080` | 服务端口 |
| `DATA_DIR` | `/data` | 价格配置持久化目录 |
| `TZ` | `Asia/Shanghai` | 时区 |

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/tokens` | 获取所有 API Key 名称 |
| GET | `/api/stats/summary` | 模型汇总统计 |
| GET | `/api/stats/daily` | 每日明细统计 |
| GET | `/api/export` | 导出 Excel |
| GET | `/api/prices` | 获取价格配置 |
| POST | `/api/prices` | 保存价格配置 |

### 查询参数

- `token_names`：逗号分隔的 Key 名称列表（不传则查全部）
- `granularity`：`today` / `week` / `month` / `last30` / `all` / `custom`
- `start` / `end`：Unix 时间戳（`granularity=custom` 时必填）
- `use_cache_price`：`1` 表示缓存读按独立价格计费

## 本地开发

```bash
# 启动后端（默认监听 :8080）
cd backend
go run .

# 启动前端（另开终端，Vite 代理 /api -> localhost:8080）
cd frontend
npm install
npm run dev
```

## 价格配置说明

- 价格单位为 **每百万 tokens**（1M = 1,000,000）
- 支持币种切换（CNY/USD），系统内部统一以 USD 存储
- **模型别名**：逗号分隔的关键词，若日志中的 `model_name` 包含任一别名即匹配该定价
- **缓存价格**：留空或设为 0 时，缓存读 token 与输入 token 同价

## 注意事项

- 本服务只需要对 new-api 数据库的 **只读权限**
- 价格配置持久化在 `./data/prices.json`（容器内挂载为 `/data`）
- 若 new-api 使用单独的 `LOG_SQL_DSN` 日志库，请将 `DB_*` 环境变量指向该数据库
