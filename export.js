/* 财务标准 Excel 导出（xlsx-js-style，浏览器端生成） */
'use strict';

const HEADER_STYLE = {
  font: { bold: true, color: { rgb: '0C447C' } },
  fill: { fgColor: { rgb: 'DDEBF7' } },
  alignment: { vertical: 'center' },
};
const YELLOW_STYLE = { fill: { fgColor: { rgb: 'FFFF00' } } };

function sheetFrom(rows, headers) {
  const ws = XLSX.utils.aoa_to_sheet([headers.map((h) => h.label), ...rows]);
  headers.forEach((h, i) => {
    const addr = XLSX.utils.encode_cell({ r: 0, c: i });
    if (ws[addr]) ws[addr].s = HEADER_STYLE;
  });
  ws['!cols'] = headers.map((h) => ({ wch: h.w || 14 }));
  return ws;
}

function exportFinanceExcel(records, params, month) {
  if (!records.length) { toast('本月没有可导出的记录'); return; }
  const wb = XLSX.utils.book_new();

  /* 1. 课时费汇总 */
  const course = records.filter((r) => r.type === 'course');
  const byPerson = {};
  course.forEach((r) => {
    const k = r.owner_name || '未署名';
    byPerson[k] = byPerson[k] || { campus: r.campus, count: 0, attend: 0 };
    byPerson[k].count += 1;
    byPerson[k].attend += Number(r.payload.attend) || 0;
  });
  const feeRows = Object.entries(byPerson).map(([name, v]) => {
    const pr = params.find((x) => x.member_name === name) || {};
    const duty = pr.duty_hours || 0;
    const price = pr.unit_price != null ? Number(pr.unit_price) : 0;
    const cap = pr.cap != null ? Number(pr.cap) : Infinity;
    const billable = Math.max(0, v.count - duty);
    const fee = Math.min(billable * price, cap === Infinity ? billable * price : cap);
    return [name, v.campus || '', pr.employment || '', v.count, duty, billable, price, cap === Infinity ? '' : cap, Number(fee.toFixed(2))];
  });
  const totalFee = feeRows.reduce((s, r) => s + r[8], 0);
  feeRows.push(['合计', '', '', '', '', '', '', '', Number(totalFee.toFixed(2))]);
  const wsFee = sheetFrom(feeRows, [
    { label: '姓名', w: 12 }, { label: '校区', w: 12 }, { label: '用工类型', w: 10 },
    { label: '课次', w: 8 }, { label: '责任课时', w: 10 }, { label: '计费课次', w: 10 },
    { label: '单价(元/节)', w: 12 }, { label: '封顶(元)', w: 10 }, { label: '课时费(元)', w: 12 },
  ]);
  XLSX.utils.book_append_sheet(wb, wsFee, '课时费汇总');

  /* 2. 课时明细 */
  const courseRows = course.map((r) => {
    const d = r.payload;
    return [r.owner_name, r.campus, d.course || '', d.date || '', `${d.start_time || ''}-${d.end_time || ''}`, d.attend ?? '', d.teach_role || '', d.afterclass || '', d.service_addr || '', STATUS[r.status].name];
  });
  XLSX.utils.book_append_sheet(wb, sheetFrom(courseRows, [
    { label: '教师', w: 12 }, { label: '校区', w: 12 }, { label: '课程', w: 14 },
    { label: '上课日期', w: 12 }, { label: '时段', w: 14 }, { label: '实到人数', w: 10 }, { label: '主教/助教', w: 10 }, { label: '课后服务', w: 10 }, { label: '课后服务地址', w: 14 }, { label: '状态', w: 12 },
  ]), '课时明细');

  /* 3. 学费提成 */
  const tuitionRows = records.filter((r) => r.type === 'tuition').map((r) => {
    const d = r.payload;
    const pr = params.find((x) => x.member_name === (d.commission_to || r.owner_name)) || {};
    const rate = pr.tuition_rate != null ? Number(pr.tuition_rate) : '';
    const comm = rate === '' ? '' : Number(((Number(d.amount) || 0) * rate).toFixed(2));
    return [r.campus, d.student || '', d.fee_type || '未填', d.amount ?? '', d.receipt_no || '', d.pay_date || '', r.owner_name, d.commission_to || '', rate === '' ? '' : rate * 100 + '%', comm];
  });
  XLSX.utils.book_append_sheet(wb, sheetFrom(tuitionRows, [
    { label: '校区', w: 12 }, { label: '学生姓名', w: 12 }, { label: '学费类型', w: 10 }, { label: '金额(元)', w: 12 }, { label: '收据编号', w: 14 },
    { label: '缴费日期', w: 12 }, { label: '经手人', w: 10 }, { label: '提成归属', w: 10 }, { label: '提成比例', w: 10 }, { label: '提成金额(元)', w: 14 },
  ]), '学费提成');

  /* 4. 物品销售 */
  const goodsRows = records.filter((r) => r.type === 'goods').map((r) => {
    const d = r.payload;
    return [r.campus, d.pay_date || '', d.item_name || '', d.barcode || '', d.qty ?? '', d.amount ?? '', d.student || '', r.owner_name, d.teacher || ''];
  });
  XLSX.utils.book_append_sheet(wb, sheetFrom(goodsRows, [
    { label: '校区', w: 12 }, { label: '日期', w: 12 }, { label: '物品名称', w: 24 }, { label: '条码', w: 12 },
    { label: '数量', w: 8 }, { label: '金额(元)', w: 12 }, { label: '学生/客户', w: 12 }, { label: '经手人', w: 10 }, { label: '授课教师', w: 10 },
  ]), '物品销售');

  /* 5. 邀约试听 */
  const inviteRows = records.filter((r) => r.type === 'invite').map((r) => {
    const d = r.payload;
    return [r.campus, d.trial_date || '', d.student || '', d.amount ?? '', r.owner_name, d.teacher || ''];
  });
  XLSX.utils.book_append_sheet(wb, sheetFrom(inviteRows, [
    { label: '校区', w: 12 }, { label: '体验日期', w: 12 }, { label: '学生姓名', w: 12 },
    { label: '意向金额(元)', w: 14 }, { label: '经手人', w: 10 }, { label: '体验课老师', w: 12 },
  ]), '邀约试听');

  /* 5.5 其他收入（不计提成业绩） */
  const otherRows = records.filter((r) => r.type === 'other_income').map((r) => {
    const d = r.payload;
    return [r.campus, d.pay_date || '', d.fee_name || '', d.amount ?? '', d.student || '', d.phone || '', r.owner_name, STATUS[r.status].name];
  });
  const otherTotal = otherRows.reduce((s, r) => s + (Number(r[3]) || 0), 0);
  otherRows.push(['合计', '', '', Number(otherTotal.toFixed(2)), '', '', '', '']);
  XLSX.utils.book_append_sheet(wb, sheetFrom(otherRows, [
    { label: '校区', w: 12 }, { label: '收款日期', w: 12 }, { label: '费用名称', w: 20 }, { label: '金额(元)', w: 12 },
    { label: '学员姓名', w: 12 }, { label: '联系电话', w: 14 }, { label: '填报人', w: 10 }, { label: '状态', w: 12 },
  ]), '其他收入');

  /* 6. 校长月度汇总 */
  const sumRows = records.filter((r) => r.type === 'summary').map((r) => {
    const d = r.payload;
    return [r.campus, d.month || '', d.total_perf ?? '', d.total_sales ?? '', d.total_hours ?? '', d.lead_hours ?? '', d.absence ?? '', d.leave ?? '', r.owner_name];
  });
  XLSX.utils.book_append_sheet(wb, sheetFrom(sumRows, [
    { label: '校区', w: 12 }, { label: '月份', w: 10 }, { label: '总业绩(元)', w: 12 }, { label: '总课销(元)', w: 12 },
    { label: '月上课总课时', w: 14 }, { label: '主教课时', w: 10 }, { label: '缺勤扣款(元)', w: 12 }, { label: '请假扣款(元)', w: 12 }, { label: '填报人', w: 10 },
  ]), '校长月度汇总');

  XLSX.writeFile(wb, `教培机构_${month}_财务核算.xlsx`);
  toast('Excel 已生成，请在下载目录查看');
}
