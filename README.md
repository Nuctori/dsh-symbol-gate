# dsh-symbol-gate

回合结束前的代码门禁。Git 工作区优先审计**本轮净文件变化**，采集不可用时回退到 `edit` / `write` 入参。它用**一次**只读 LLM 调用审计，发现 blocker/major 时提醒主 agent。无需额外 npm 依赖。

## 它是什么，不是什么

它是**反例检测器**，不是类型检查器。没有类型信息，它不可能证明代码正确；它只找出能从 diff 文本直接指认的、类型论上不可辩护的写法。任何“不确定”的推断都会被丢弃。

## 机制

```
agent/pre-step（首步）→ 读取 Git 工作区文件基线
agent/turn-stopping
  ↓ Git 基线与收尾文件内容比较，对变化文件运行 git diff --no-index
  ↓ 无可用基线、目录改变、失败或超预算 → 回退 edit/write 入参
  ↓ 审计输入受单文件和全轮字符预算限制
  ↓ 一次只读子代理（toolFilter allow 为空）
  ↓ findings 归一化 → blocker/major 才注入
  ↓ agent.inject(findings) + agent.steer(提示)
```

关键约束：

- **Git 优先**：只比较回合前后已跟踪及非忽略新文件的工作树内容。回合前已有且本轮未变的文件不会作为发现输入；只改暂存区、不改工作树内容不算变化。不会改写真实 index、分支或工作树；跳过非 UTF-8、二进制与符号链接。
- **一次调用**：整轮聚合后只审一次，按 `turn/start` 的 seq 记账，重复触发不再审。
- **只读**：判定者 `toolFilter: { allow: [] }`，无工具、不执行、不写文件。
- **失败即放行**：子代理缺失、超时、未完成、输出非法 → 全部 pass，绝不打断收尾。
- **minor 不拦**：只有 blocker/major 触发注入。

## checklist（判定者的固定清单）

| 维度 | 检查 |
|---|---|
| binding | 新增标识符是否有定义；引用是否指错符号；遮蔽是否误用 |
| linearity | 资源是否恰好释放一次；异常/提前返回路径是否泄漏；是否重复释放 |
| effect | Promise 是否 await；catch 是否吞错；finally 是否覆盖异常；错误类型是否丢失 |
| assertion | `as any` / `as unknown` / `!` / `@ts-ignore` 是否掩盖不成立的假设 |
| exhaustiveness | 联合类型的 switch/match 是否覆盖全部构造子 |
| ordering | 校验是否先于副作用；部分失败是否留下半更新状态 |

提示词要求每条发现都能从改动中指出触发条件和可观察后果；缺少上下文不当作缺陷。同根因、同修法合并，按严重度排序后最多报告 5 条。

### 风格维度（`style: true` 才启用）

只收类型论里可判定的四条，**severity 固定 `minor`，永远不翻转裁决、不触发 steer**：

| 规则 | 依据 | 检查 |
|---|---|---|
| 未使用绑定 | 仿射性：用了零次就是浪费 | 新增变量/参数/导入未被使用 |
| 总函数优先 | 类型即命题，`throw` / `null` 放弃了定义域的一部分 | 可预期输入下抛异常或返回 null |
| 抽象不泄漏 | 存在类型 | 返回内部可变引用、暴露实现类型 |
| 单一表示 | 同构唯一性 | 同一概念出现两种可派生的表示 |

明确**禁止**评价命名、注释、格式、函数长度、嵌套层级、抽象层级——这些不是类型论可判定的，收进来只会变成口味警察。

有 style 项时它单独成段附在注入末尾；只有 style、没有 blocker/major 时**完全不注入**。

## 安装

desktop profile 由 Electron 独占，CLI 会拒绝；web 可以直接装：

```sh
dsh plugin --profile web add D:\projects\dsh-symbol-gate
```

desktop 走桌面端插件管理，或手工改 profile 后 `pnpm install`（见同系列的 DEPLOY 写法）。

装完重启宿主。

## 配置

```yaml
- insert:
    - id: symbol-gate
      name: 'dsh-symbol-gate'
      config:
        maxFindings: 5
        maxFileChars: 4000
        steer: true
```

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `provider` | `'spawn'` | 审计子代理 provider |
| `timeoutMs` | `45000` | 审计超时，超时按 pass |
| `maxFileChars` | `4000` | 单个改动的字符预算 |
| `maxTotalChars` | `20000` | 整轮改动的字符预算 |
| `gitTimeoutMs` | `2000` | Git 基线和收尾采集各自的时间预算（毫秒） |
| `gitMaxBytes` | `8388608` | 单次 Git 文件快照的内容字节上限；超限回退工具采集 |
| `maxFindings` | `5` | 保留的 findings 上限 |
| `mutationTools` | `['edit','write']` | 视为代码改动的工具名 |
| `steer` | `true` | 有问题时是否 steer 主 agent 先修 |
| `style` | `false` | 是否附加四条形式化风格检查（固定 minor，不阻塞） |

## 测试

```sh
node --test
```

用例覆盖：提示词契约、diff 提取（edit/write/多文件/跨轮隔离/非法参数）、预算截断、语言识别、提示组装、findings 归一化与限量、severity 裁决、只读请求、每 turn 一次、风格维度开关与分段、各类失败降级。

## 限制

- 没有类型信息，无法证明正确性；只报可指认的反例。
- 只有 diff 片段，跨文件的符号解析不在范围内。Git 采集只看回合开始时的工作目录及其子目录，不覆盖仓库外文件、子模块内容、纯文件权限变化和回合中并发编辑的归因；时间窗口内他人的改动也可能被纳入。大仓库触及采集预算时回退工具事件。
- 已发生的改动拦不住：门禁只能在下一步之前告知并让模型自己修。
- 与 `dsh-drift-gate` 若同时启用，两者都在 `turn-stopping` 注入，会看到两条独立提示。
