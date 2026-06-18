# Token 用量查询平台

基于 new-api 的 MySQL 日志数据库，统计指定 API Key 的 token 使用量及费用。

## 功能

- 按 API Key (`token_name`) 筛选，支持多选
- 时间维度：今日 / 本周 / 本月 / 近30天 / 自定义范围
- 按模型汇总统计（请求数、输入/输出/缓存 token、费用）
- 每日每 Key 每模型的明细视图
- 自定义模型价格（USD/CNY，支持模型别名映射）
- 导出 Excel（含汇总和明细两个 Sheet）

## 部署（Docker Compose）

```bash
# 1. 复制并填写环境变量
cp .env.example .env
# 编辑 .env，填入 new-api 的数据库连接信息

# 2. 构建并启动
docker compose up -d --build

# 访问 http://localhost:8080
```

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

## 本地开发

```bash
# 后端
cd backend
go run .

# 前端（另开终端）
cd frontend
npm install
npm run dev    # 代理 /api 到 localhost:8080
```

## 注意

- 只需要对 new-api 数据库的**只读权限**
- 价格配置持久化在 `./data/prices.json`（容器内挂载为 `/data`）
- 若 new-api 使用单独的 `LOG_SQL_DSN` 日志库，请将 `DB_*` 环境变量指向该数据库
