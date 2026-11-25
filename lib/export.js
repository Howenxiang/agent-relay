// 房间联调纪要（SYNC_REPORT.md）与最终契约包（.zip）生成器
const { createZip } = require('./zip');

const PROPOSAL_LABELS = {
  pending: '⏳ 待拍板',
  approved: '✅ 已通过',
  changes_requested: '✎ 需修改',
  rejected: '❌ 已驳回',
};

function fmtIso(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return String(iso);
  }
}

function buildSyncReportMarkdown(room, agents, { includeDebug = false, exportedAt = new Date().toISOString() } = {}) {
  const artifacts = Object.values(room.artifacts || {}).sort((a, b) => a.name.localeCompare(b.name));
  const proposals = room.messages.filter(m => m.kind === 'proposal' || m.proposal);
  const messages = includeDebug ? room.messages : room.messages.filter(m => m.kind !== 'debug');

  const lines = [
    `# #${room.name} 联调纪要与契约汇总`,
    '',
    `- **房间 ID**：\`${room.id}\``,
    `- **主题**：${room.topic || '（未设置）'}`,
    `- **导出时间**：${fmtIso(exportedAt)}`,
    `- **房间状态**：${room.paused ? `⏸ 已暂停（${room.pausedReason || '管理员暂停'}）` : '▶ 正常进行中'}`,
    `- **统计**：消息 ${room.messages.length} 条 · 变更提案 ${proposals.length} 项 · 共享契约 ${artifacts.length} 份`,
    '',
  ];

  // 1. 参与成员与项目名片
  lines.push('## 1. 参与成员与项目名片', '');
  if (!agents.length) {
    lines.push('（导出时暂无在线或已记录成员）', '');
  } else {
    lines.push('| 成员 | 角色 | 身份 | 项目 | 负责人 | 技术栈 / 分支 | 本地地址 / 文档 |');
    lines.push('| :--- | :--- | :--- | :--- | :--- | :--- | :--- |');
    for (const a of agents) {
      const c = a.card || {};
      const idLabel = a.verified ? `已验证 \`${a.id}\`` : '访客';
      const stackBranch = [c.stack, c.branch ? `\`${c.branch}\`` : ''].filter(Boolean).join(' / ') || '-';
      const urls = [c.localEndpoint, c.apiDoc].filter(Boolean).join('<br/>') || '-';
      lines.push(`| ${a.name} | ${a.role} | ${idLabel} | ${c.project || '-'} | ${c.owner || '-'} | ${stackBranch} | ${urls} |`);
    }
    lines.push('');
  }

  // 2. 变更提案与拍板结论
  lines.push('## 2. 变更提案与审批结论', '');
  if (!proposals.length) {
    lines.push('（本次联调未发起变更提案）', '');
  } else {
    for (const p of proposals) {
      const status = p.proposal?.status || 'pending';
      lines.push(`### 提案 #${p.seq} · ${PROPOSAL_LABELS[status] || status}`);
      lines.push(`- 发起人：**${p.agent}**（${p.role}） · ${fmtIso(p.at)}`);
      lines.push('', p.text, '');
      const decisions = p.proposal?.decisions || [];
      if (decisions.length) {
        lines.push('**审批记录：**');
        for (const d of decisions) {
          lines.push(`- ${fmtIso(d.at)} **${d.by}**（${d.role || 'Human'}）→ **${PROPOSAL_LABELS[d.decision] || d.decision}**${d.comment ? `：${d.comment}` : ''}`);
        }
        lines.push('');
      }
    }
  }

  // 3. 最终共享契约清单
  lines.push('## 3. 最终共享契约清单（Artifacts）', '');
  if (!artifacts.length) {
    lines.push('（暂无共享契约）', '');
  } else {
    lines.push('| 文件名 | 最新版本 | 大小 | 最后更新人 | 更新时间 | 变更说明 |');
    lines.push('| :--- | :--- | :--- | :--- | :--- | :--- |');
    for (const a of artifacts) {
      lines.push(`| \`artifacts/${a.name}\` | v${a.version} | ${a.size} B | ${a.updatedBy} | ${fmtIso(a.updatedAt)} | ${a.summary || a.title || '-'} |`);
    }
    lines.push('');
  }

  // 4. 讨论纪要
  lines.push(`## 4. 讨论记录${includeDebug ? '（含调试日志）' : '（已过滤调试日志）'}`, '');
  if (!messages.length) {
    lines.push('（暂无讨论记录）', '');
  } else {
    for (const m of messages) {
      const tag = m.kind && m.kind !== 'message' ? ` \`<${m.kind}>\`` : '';
      const reply = m.replyTo ? ` ↩ #${m.replyTo}` : '';
      const verified = m.verified ? ` *(已验证 ${m.agentId})*` : '';
      lines.push(`### #${m.seq} · ${m.agent}${verified}${tag}${reply} — ${fmtIso(m.at)}`, '', m.text, '');
    }
  }

  return `${lines.join('\n')}\n`;
}

function buildRoomExportZip(room, agents, { includeDebug = false } = {}) {
  const exportedAt = new Date().toISOString();
  const reportMd = buildSyncReportMarkdown(room, agents, { includeDebug, exportedAt });
  const artifacts = Object.values(room.artifacts || {}).sort((a, b) => a.name.localeCompare(b.name));

  const transcript = {
    exportedAt,
    room: {
      id: room.id,
      name: room.name,
      topic: room.topic,
      paused: Boolean(room.paused),
      pausedReason: room.pausedReason || '',
      lastSeq: room.seq,
    },
    agents,
    artifacts: artifacts.map(({ revisions, content, ...meta }) => meta),
    proposals: room.messages.filter(m => m.kind === 'proposal' || m.proposal),
    messages: includeDebug ? room.messages : room.messages.filter(m => m.kind !== 'debug'),
  };

  const entries = [
    { name: 'SYNC_REPORT.md', content: reportMd, mtime: exportedAt },
    { name: 'transcript.json', content: JSON.stringify(transcript, null, 2), mtime: exportedAt },
  ];
  for (const a of artifacts) {
    entries.push({ name: `artifacts/${a.name}`, content: a.content, mtime: a.updatedAt || exportedAt });
  }
  return {
    zip: createZip(entries),
    reportMd,
    transcript,
    filename: `${room.id}-sync-${exportedAt.slice(0, 10)}.zip`,
  };
}

module.exports = { buildSyncReportMarkdown, buildRoomExportZip };
