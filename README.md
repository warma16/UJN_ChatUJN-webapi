# 注意
本工具仅供技术研究，使用者应于24小时内删除从济南大学ChatUJN平台获取的非公开数据。开发者不对任何学术诚信审查问题负责，请优先在智慧济大中的ChatUJN开通API权限。 本程序不保证您的信息安全，使用者应自行承担风险。请勿将本程序用于非法用途，否则后果自负。 开发者不对使用本程序导致的任何问题负责。 请勿滥用！！！

# 鸣谢
感谢济南大学信息管理处教育技术与网络信息中心为济大学子提供的免费大模型调用服务。

也感谢 @zeroHYH @futz12 @szw0407 以及开源项目 SDU_DeepSeek——本作正是在它的基础上定制完善的。 
# UJN DeepSeek WebAPI

## 要求

- **本地开发**（跑 TS 源码）：Node.js ≥ 23.6（原生运行 TypeScript，无需编译步骤）
- **使用已发布包**（`npx` / 全局安装，跑编译后 JS）：Node.js ≥ 18

## 安装与运行

**本地开发：**
```bash
npm install
```

**npx ：**
```bash
#server
npx -p @ocero/ujn-deepseek-webapi-node@latest ujn-serve -u 2021001234 -p 你的密码
#cli
npx -p @ocero/ujn-deepseek-webapi-node@latest ujn-chat
```

**启动 API 服务**
```bash
# 账号密码为必需；host/port 可选
#   方式一：-u / -p 标记
node src/server.ts -u 2021001234 -p 你的密码 --port 8000
#   方式二：位置参数（经 npm start 透传时 -u/-p 会被 npm 吞掉，务必用这种）
npm start -- 2021001234 你的密码
#   直接运行也支持位置参数
node src/server.ts 2021001234 你的密码 --port 8000
```

服务起来后（默认 `http://127.0.0.1:8000`）：
- **OpenAI 客户端**连 `/v1`，例如 `http://127.0.0.1:8000/v1`
- **Anthropic / Claude Code** 连根地址 `http://127.0.0.1:8000`，并设 `ANTHROPIC_BASE_URL`（Anthropic ⇄ OpenAI 自动双向转换）
- 模型列表见 `GET /v1/models` 或 CLI 选择

**交互式 CLI（自动拉起本地服务）**
```bash
npm run cli
```

**开发**
```bash
npm run typecheck   # 类型检查
npm run build       # 编译 src → dist（发布包用）
```


