/**
 * audit-scan · 获客全链路快速体检 CLI（pnpm audit:scan）
 * 流程：mock 双线快照（合成，含演示埋点）→ runFastScan →
 *       控制台输出《获客全链路快速体检报告》摘要 → 写事件库（五元事件，actor=audit-engine，只读动作）。
 * 纪律：
 *  - 全程只读：不写任何 PMS/OTA/社媒/GEO 平台；唯一写入是系统事件库（gateway 通道，F1.2）；
 *  - 确定性：合成快照全部硬编码（禁止 Math.random），同环境多次运行结果一致；
 *  - DB 不可用时降级为「仅控制台报告」（事件写失败不阻塞报告交付，打印告警）。
 */
import { appendEvent } from "@workloom/base/workdata";
import { closeAllPools, getGatewayPool } from "@workloom/db";
import { runFastScan, type AuditReport, type AuditSnapshot, type Finding } from "@workloom/audit-engine";

/** 报告锚定时间（演示口径同日） */
const NOW = new Date("2026-08-27T10:30:00+08:00");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const daysAhead = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString().slice(0, 10);

/**
 * 合成演示快照：云栖酒店（演示租户 tenant-demo / ws-yunqi，与 seed.ts 同源口径）。
 * 含已知演示问题（双线）：
 *  酒店运营线：跨渠道倒挂 12% / 破保底价 / 超售 / 漏售 / 佣金多提 / 差评 36h 未回 / 评分双红线 / 关键词聚集
 *  获客转化线：断更 9 天 / 高潜未复用 / GEO 品牌词缺席 + 品类词竞对截流 / 落地页无 FAQ / 高意向私信 20h 未回 / 询盘 60h 未跟进 / 爆款未挂组件
 */
function buildMockSnapshot(): AuditSnapshot {
  const base = { accountId: "dy-yunqi-01", title: "日常实拍", likes: 120, comments: 14, shares: 6, hasConversionComponent: true };
  return {
    snapshotId: `SNAP-${NOW.toISOString().slice(0, 10)}`,
    generatedAt: NOW.toISOString(),
    hotels: [
      {
        hotelId: "H-YUNQI-001",
        hotelName: "云栖酒店",
        currency: "CNY",
        timezone: "Asia/Shanghai",
        floorPrice: 380,
        roomCount: 60,
        rating: 4.1,
        ratingDelta30d: -0.4,
        channels: [
          { channel: "ctrip", commissionRate: 0.15 },
          { channel: "meituan", commissionRate: 0.12 },
          { channel: "fliggy", commissionRate: 0.1 },
        ],
      },
    ],
    roomTypes: [
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-DELUXE-KING", name: "豪华大床房", basePrice: 550, currency: "CNY" },
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-STD-TWIN", name: "高级双床房", basePrice: 420, currency: "CNY" },
    ],
    channelPrices: [
      // 倒挂 12%：携程 528 vs 美团 600
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-DELUXE-KING", date: daysAhead(5), channel: "ctrip", price: 528, currency: "CNY" },
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-DELUXE-KING", date: daysAhead(5), channel: "meituan", price: 600, currency: "CNY" },
      // 破保底价：飞猪 360 < 380（3 天）
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-STD-TWIN", date: daysAhead(6), channel: "fliggy", price: 360, currency: "CNY" },
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-STD-TWIN", date: daysAhead(7), channel: "fliggy", price: 360, currency: "CNY" },
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-STD-TWIN", date: daysAhead(8), channel: "fliggy", price: 360, currency: "CNY" },
      // 远期日历：平日 500 基准，国庆未调价
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-DELUXE-KING", date: daysAhead(14), channel: "ctrip", price: 500, currency: "CNY" },
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-DELUXE-KING", date: daysAhead(15), channel: "ctrip", price: 500, currency: "CNY" },
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-DELUXE-KING", date: daysAhead(16), channel: "ctrip", price: 500, currency: "CNY" },
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-DELUXE-KING", date: "2026-10-01", channel: "ctrip", price: 500, currency: "CNY" },
    ],
    roomDays: [
      // 超售：已售 21 > 实盘 20
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-DELUXE-KING", date: daysAhead(9), channel: "ctrip", totalRooms: 20, sold: 21, maintenanceRooms: 0, available: 0, closed: false },
      // 漏售：美团关房 2 天但 PMS 有净房
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-STD-TWIN", date: daysAhead(10), channel: "meituan", totalRooms: 25, sold: 15, maintenanceRooms: 0, available: 0, closed: true },
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-STD-TWIN", date: daysAhead(11), channel: "meituan", totalRooms: 25, sold: 15, maintenanceRooms: 0, available: 0, closed: true },
      // 健康对照行
      { hotelId: "H-YUNQI-001", roomTypeId: "RT-DELUXE-KING", date: daysAhead(10), channel: "ctrip", totalRooms: 20, sold: 12, maintenanceRooms: 1, available: 7, closed: false },
    ],
    orders: [
      { hotelId: "H-YUNQI-001", orderId: "O-9001", channel: "ctrip", roomTypeId: "RT-DELUXE-KING", amount: 20000, currency: "CNY", nights: 38, status: "completed", checkIn: daysAhead(1), createdAt: daysAgo(12) },
      { hotelId: "H-YUNQI-001", orderId: "O-9002", channel: "meituan", roomTypeId: "RT-STD-TWIN", amount: 2500, currency: "CNY", nights: 5, status: "completed", checkIn: daysAhead(2), createdAt: daysAgo(10) },
      { hotelId: "H-YUNQI-001", orderId: "O-9003", channel: "fliggy", roomTypeId: "RT-STD-TWIN", amount: 1500, currency: "CNY", nights: 3, status: "completed", checkIn: daysAhead(3), createdAt: daysAgo(8) },
    ],
    channelBills: [
      // 佣金多提 3pp：应提 20000×15%=3000，实提 3600（差 600 > 500 → P1）
      {
        hotelId: "H-YUNQI-001",
        channel: "ctrip",
        billId: "BILL-202608",
        period: "2026-08",
        lines: [
          { lineId: "BL-1", type: "order", refId: "O-9001", amount: 20000, currency: "CNY" },
          { lineId: "BL-2", type: "commission", refId: "O-9001", amount: 3600, currency: "CNY" },
        ],
      },
    ],
    reviews: [
      // 差评 36h 未回（>24h SLA）+ 「隔音」聚集 3 条
      { hotelId: "H-YUNQI-001", reviewId: "RV-BAD-001", channel: "ctrip", roomTypeId: "RT-DELUXE-KING", rating: 2, createdAt: hoursAgo(36), content: "空调坏了没人修，卫生也一般" },
      { hotelId: "H-YUNQI-001", reviewId: "RV-101", channel: "ctrip", rating: 2, createdAt: hoursAgo(50), repliedAt: hoursAgo(49), content: "隔音太差，半夜被吵醒" },
      { hotelId: "H-YUNQI-001", reviewId: "RV-102", channel: "meituan", rating: 1, createdAt: hoursAgo(60), repliedAt: hoursAgo(59), content: "隔音差到离谱" },
      { hotelId: "H-YUNQI-001", reviewId: "RV-103", channel: "fliggy", rating: 3, createdAt: hoursAgo(70), repliedAt: hoursAgo(68), content: "房间隔音不好" },
      { hotelId: "H-YUNQI-001", reviewId: "RV-GOOD-001", channel: "meituan", rating: 5, createdAt: hoursAgo(10), repliedAt: hoursAgo(9), content: "服务很好" },
    ],
    holidays: ["2026-10-01", "2026-10-02"],
    /* ---------- 获客转化侧 ---------- */
    accounts: [
      {
        accountId: "dy-yunqi-01",
        hotelId: "H-YUNQI-001",
        platformId: "douyin",
        accountName: "云栖酒店官方号",
        followers: 20000,
        profile: { avatar: true, bio: true, showcase: true, booking: false, contact: true },
        violations: [{ violationId: "V-1", type: "导流处罚", occurredAt: daysAgo(20), level: "minor" }],
        expectedPostsPerWeek: 4,
        autoReply: { configured: true, active: true },
      },
    ],
    contents: [
      // 爆款未挂组件：30000 播放 = 基准 ×6，零挂载（40 天前发布，不破坏断更口径）
      { ...base, contentId: "C-HIT", title: "泳池落日爆款", publishedAt: daysAgo(40), plays: 30000, hasConversionComponent: false, topic: "泳池落日" },
      // 断更 9 天：最新一条在 9 天前；基准池 5 条
      ...[0, 1, 2, 3, 4].map((i) => ({ ...base, contentId: `C-B${i}`, publishedAt: daysAgo(9 + i * 3), plays: 5000, completionRate: 0.32 })),
      { ...base, contentId: "C-LATEST", publishedAt: daysAgo(9), plays: 4800, completionRate: 0.3 },
    ],
    directMessages: [
      // 高意向私信 20h 未回（>12h → P0）
      { accountId: "dy-yunqi-01", messageId: "DM-1", text: "请问本周六还有亲子房吗？两大一小", receivedAt: hoursAgo(20), isInquiry: true },
      { accountId: "dy-yunqi-01", messageId: "DM-2", text: "停车场收费吗", receivedAt: hoursAgo(3), respondedAt: hoursAgo(2) },
    ],
    leads: [
      // 询盘 60h 未跟进（>48h）
      { accountId: "dy-yunqi-01", leadId: "LD-1", inquiryAt: hoursAgo(60), sourceContentId: "C-HIT" },
      // 已跟进 10 天无到店（线索-到店断点）
      { accountId: "dy-yunqi-01", leadId: "LD-2", inquiryAt: daysAgo(10), followedUpAt: daysAgo(9) },
      // 健康对照：已到店
      { accountId: "dy-yunqi-01", leadId: "LD-3", inquiryAt: daysAgo(6), followedUpAt: daysAgo(6), visitedAt: daysAgo(5) },
    ],
    /* ---------- GEO 能见度侧 ---------- */
    geoQueries: [
      // P0 品牌词缺席
      { hotelId: "H-YUNQI-001", query: "云栖酒店怎么样", type: "brand", priority: "P0", mentioned: false, competitorsCited: [], platform: "deepseek" },
      // 品类词竞对截流
      { hotelId: "H-YUNQI-001", query: "杭州西湖边亲子酒店推荐", type: "category", priority: "P1", mentioned: false, competitorsCited: ["竞对A民宿", "竞对B酒店"], platform: "doubao" },
      // 健康对照：品牌词已首推
      { hotelId: "H-YUNQI-001", query: "云栖酒店电话", type: "brand", priority: "P1", mentioned: true, firstRecommended: true, competitorsCited: [], platform: "deepseek" },
    ],
    geoAssets: [
      { hotelId: "H-YUNQI-001", assetId: "GA-1", title: "官网首页", url: "https://example.invalid/", hasFaqBlock: false, hasStructuredData: false },
      { hotelId: "H-YUNQI-001", assetId: "GA-2", title: "亲子房落地页", hasFaqBlock: false, hasStructuredData: true },
      { hotelId: "H-YUNQI-001", assetId: "GA-3", title: "常见问题 FAQ 页", hasFaqBlock: true, hasStructuredData: true },
    ],
  };
}

/** 链路环节中文名 */
const STAGE_LABEL = { traffic: "流量（账号/GEO）", conversion: "转化（私信/线索/组件）", deal: "成交（房价/房态/渠道/口碑）" } as const;

/** 控制台报告摘要（按「流量→转化→成交」链路分组） */
function printReport(snapshot: AuditSnapshot, report: AuditReport, eventId?: string): void {
  const line = "─".repeat(68);
  console.log(line);
  console.log(`《获客全链路快速体检报告》 ${report.reportId} · 生成于 ${report.generatedAt}`);
  console.log(`快照 ${snapshot.snapshotId} · 门店 ${report.overview.hotelCount} 家 · 数据源覆盖：${
    Object.entries(report.coverage).map(([k, v]) => `${k}=${v === "covered" ? "✓" : v === "partial" ? "△" : "✗"}`).join(" ")
  }`);
  if (report.coverageNotes.length > 0) console.log(`降级说明：${report.coverageNotes.join("；")}`);
  console.log(line);
  const { counts, findingCount, totalRecoverableByUnit } = report.overview;
  console.log(`发现 ${findingCount} 条（P0=${counts.P0} / P1=${counts.P1} / P2=${counts.P2}）`);
  const totals = Object.entries(totalRecoverableByUnit).map(([u, a]) => `${a.toLocaleString()} ${u}`).join(" + ");
  console.log(`估算挽回空间：${totals || "—"}（分单位口径，详见各发现 confidence/basis 标注）`);
  console.log(line);
  const impactOf = (f: Finding) =>
    f.estimatedImpact ? `${f.estimatedImpact.amount.toLocaleString()} ${f.estimatedImpact.currency}/${f.estimatedImpact.period} [${f.estimatedImpact.confidence}]` : "—";
  for (const stage of ["traffic", "conversion", "deal"] as const) {
    const fs = report.chainGroups[stage];
    if (fs.length === 0) continue;
    console.log(`◆ ${STAGE_LABEL[stage]} · ${fs.length} 条`);
    for (const f of fs) {
      console.log(`  [${f.severity}] ${f.title}`);
      console.log(`      挽回≈${impactOf(f)}`);
    }
  }
  console.log(line);
  console.log("Top 行动清单（按年化挽回降序，最多 10 条）：");
  report.top10.forEach((f, i) => {
    console.log(` ${String(i + 1).padStart(2)}. [${f.severity}] ${f.title}`);
    console.log(`     环节=${STAGE_LABEL[Object.entries(report.chainGroups).find(([, g]) => g.some((x) => x.id === f.id))?.[0] as keyof typeof STAGE_LABEL ?? "deal"]} · 挽回≈${impactOf(f)}`);
    console.log(`     建议：${f.suggestion}`);
  });
  console.log(line);
  console.log(`耗时 ${report.elapsedMs}ms（软预算 ${report.timeBudgetMinutes} 分钟）· 全程只读`);
  if (eventId) console.log(`报告事件已入库：${eventId}（actor=audit-engine，action=audit.fast-scan.report）`);
}

async function main(): Promise<void> {
  const snapshot = buildMockSnapshot();
  console.log(
    `[audit-scan] mock 双线快照就绪：hotels=${snapshot.hotels.length} channelPrices=${snapshot.channelPrices.length} roomDays=${snapshot.roomDays.length} orders=${snapshot.orders.length} bills=${snapshot.channelBills.length} reviews=${snapshot.reviews.length} | accounts=${snapshot.accounts.length} contents=${snapshot.contents.length} dms=${snapshot.directMessages.length} leads=${snapshot.leads.length} | geoQueries=${snapshot.geoQueries.length} geoAssets=${snapshot.geoAssets.length}`,
  );

  const report = runFastScan(snapshot, { now: NOW, timeBudgetMinutes: 30 });

  // 写事件库（五元事件；DB 不可达时降级为仅控制台报告，不阻塞交付）
  let eventId: string | undefined;
  try {
    const gateway = getGatewayPool();
    const r = await appendEvent(
      gateway,
      { tenantId: "tenant-demo", workspaceId: "ws-yunqi" },
      {
        event: {
          who: { type: "agent", id: "audit-engine", version: "0.1.0" },
          context: { tenant_id: "tenant-demo", workspace_id: "ws-yunqi", time: NOW.toISOString(), channel: "cli", stage: "audit" },
          object: { type: "audit-report", id: report.reportId },
          decision: {
            action: "audit.fast-scan.report",
            after: {
              findingCount: report.overview.findingCount,
              counts: report.overview.counts,
              totalRecoverableByUnit: report.overview.totalRecoverableByUnit,
              coverage: report.coverage,
              top10: report.top10.map((f) => ({ id: f.id, line: f.line, severity: f.severity, title: f.title, impact: f.estimatedImpact })),
            },
            basis: ["fast-scan 双线七线扫描（bundles/hotel/skills/fast-scan）", "全程只读：未调用任何 PMS/OTA/社媒/GEO 写接口"],
          },
          rule_impact: [{ rule_id: "audit-only-readonly", version: "v1", result: "pass" }],
        },
      },
    );
    eventId = r.eventId;
    await closeAllPools();
  } catch (err) {
    console.warn(`[audit-scan] 事件库写入失败（降级为仅控制台报告）：${err instanceof Error ? err.message : String(err)}`);
  }

  printReport(snapshot, report, eventId);
}

await main();
