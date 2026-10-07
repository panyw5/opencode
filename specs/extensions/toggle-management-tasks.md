# 配置页扩展启停管理

日期：2026-10-06；用户批准启停计划。仅extensions-p0工作树，不暂存/提交/推送/合入dev。

- [x] API启停SDK封装与host统一mutation/reconcile，同ID保存互斥与服务器切换守卫；独立核对与helper/API回归通过，provider装配完整并发覆盖仍为限制。
- [x] 详情动作按钮、两步停用确认、busy/失败/同步警告；10项隔离真实动作契约通过（含服务器切换迟到成功反馈丢弃）。
- [x] 表单dirty/saving反馈与管理请求期间编辑禁用，取消修改恢复快照；10项隔离真实表单契约通过（含不可提交的无效数字编辑也阻止启停且可取消）。
- [x] safe mode/incompatible/error真实状态规则，5项纯门禁回归通过。
- [x] 单元/隔离browser契约、app全量1387/0、browser61/0（子进程另验10动作+10表单）、typecheck18/18、production build、格式检查通过。
- [x] 页面按钮真实确认/取消、停用状态/viewer/CSS撤销/child退出、再启用viewer/CSS恢复；浏览器和5194/47241服务已清理。
- [ ] 剩余实机：恢复后RPC、dirty/saving门禁、真实多服务器A→B→A；环境明确拒绝后按用户选择保留限制，不绕过。
- [x] 更新进度/交付清单，125候选逐项校验无遗漏/重复。

不增加安装、链接、卸载、市场或后端接口，不把registry enabled=true等同实际激活成功。
