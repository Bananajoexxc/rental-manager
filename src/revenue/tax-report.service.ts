import { Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit');
import { RevenueService } from './revenue.service';

/**
 * Generates a multi-page PDF tax report covering all rental years,
 * deductions, penalties, and strategic recommendations.
 */
@Injectable()
export class TaxReportService {
  constructor(private readonly revenueService: RevenueService) {}

  /** Generate the full tax report PDF and return as a Buffer */
  async generateTaxReport(account?: string): Promise<Buffer> {
    const data = await this.revenueService.getMultiYearTaxSummary(account);
    const now = new Date();

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 50, bottom: 50, left: 50, right: 50 },
        info: {
          Title: 'UK Self-Employment Tax Report — DB Cinema & Leo Adams',
          Author: 'Rental Manager Tax Calculator',
          Subject: `Tax years 2022/23 through 2025/26 — generated ${now.toLocaleDateString('en-GB')}`,
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const PAGE_W = 495; // usable width (A4 - margins)
      const COLORS = {
        primary: '#1a1a2e',
        red: '#dc2626',
        green: '#16a34a',
        amber: '#d97706',
        blue: '#2563eb',
        purple: '#7c3aed',
        grey: '#6b7280',
        lightGrey: '#9ca3af',
        bg: '#f8fafc',
        tableBorder: '#e2e8f0',
        tableHeader: '#f1f5f9',
      };

      // ═══════════════════════════════════════════════════════════════
      // HELPER FUNCTIONS
      // ═══════════════════════════════════════════════════════════════

      const fmt = (n: number) => '£' + Math.round(n).toLocaleString('en-GB');
      const fmtPct = (n: number) => n.toFixed(1) + '%';

      const heading = (text: string, size = 18, color = COLORS.primary) => {
        doc.fontSize(size).font('Helvetica-Bold').fillColor(color).text(text, 50, doc.y, { width: PAGE_W });
        doc.moveDown(0.3);
      };

      const subheading = (text: string, size = 13, color = COLORS.primary) => {
        doc.fontSize(size).font('Helvetica-Bold').fillColor(color).text(text, 50, doc.y, { width: PAGE_W });
        doc.moveDown(0.2);
      };

      const body = (text: string, size = 10, color = COLORS.primary) => {
        doc.fontSize(size).font('Helvetica').fillColor(color).text(text, 50, doc.y, { width: PAGE_W, lineGap: 3 });
      };

      const bodyBold = (text: string, size = 10, color = COLORS.primary) => {
        doc.fontSize(size).font('Helvetica-Bold').fillColor(color).text(text, 50, doc.y, { width: PAGE_W, lineGap: 3 });
      };

      const separator = () => {
        doc.moveDown(0.4);
        doc.strokeColor(COLORS.tableBorder).lineWidth(0.5)
          .moveTo(50, doc.y).lineTo(545, doc.y).stroke();
        doc.moveDown(0.4);
      };

      const checkPage = (needed = 120) => {
        if (doc.y > 750 - needed) doc.addPage();
      };

      /** Draw a simple table — uses absolute positioning to prevent cursor drift */
      const drawTable = (headers: string[], rows: string[][], colWidths: number[], opts?: { headerColor?: string; highlightLast?: boolean }) => {
        const startX = 50;
        const rowH = 18;
        const headerColor = opts?.headerColor || COLORS.tableHeader;

        // Check if we need a new page
        checkPage(rowH * (rows.length + 2));

        // Save starting Y
        const tableStartY = doc.y;

        // Header background
        doc.rect(startX, tableStartY, PAGE_W, rowH).fill(headerColor);

        // Header text — absolute position each cell, lineBreak:false prevents cursor movement
        let x = startX;
        for (let i = 0; i < headers.length; i++) {
          doc.fontSize(8).font('Helvetica-Bold').fillColor(COLORS.primary)
            .text(headers[i], x + 4, tableStartY + 5, { width: colWidths[i] - 8, align: i === 0 ? 'left' : 'right', lineBreak: false });
          x += colWidths[i];
        }

        let y = tableStartY + rowH;

        // Rows
        for (let ri = 0; ri < rows.length; ri++) {
          if (y > 750) { doc.addPage(); y = 50; }
          const row = rows[ri];
          const isLast = ri === rows.length - 1 && opts?.highlightLast;

          // Row background
          if (isLast) {
            doc.rect(startX, y, PAGE_W, rowH).fill('#fef3c7');
          } else if (ri % 2 === 0) {
            doc.rect(startX, y, PAGE_W, rowH).fill('#fafafa');
          }

          // Row cells — absolute position each
          x = startX;
          for (let ci = 0; ci < row.length; ci++) {
            const cell = row[ci];
            const isAmount = ci > 0 && cell.startsWith('£');
            const isNeg = cell.startsWith('-£') || cell.startsWith('-');
            const color = isLast ? COLORS.primary : (isNeg ? COLORS.red : (isAmount ? COLORS.green : COLORS.primary));
            const font = isLast ? 'Helvetica-Bold' : 'Helvetica';
            doc.fontSize(8).font(font).fillColor(color)
              .text(cell, x + 4, y + 5, { width: colWidths[ci] - 8, align: ci === 0 ? 'left' : 'right', lineBreak: false });
            x += colWidths[ci];
          }
          y += rowH;
        }

        // Set doc.y to after the table
        doc.x = 50;
        doc.y = y + 4;
      };

      const bulletList = (items: string[]) => {
        items.forEach(item => {
          checkPage(25);
          doc.fontSize(9).font('Helvetica').fillColor(COLORS.primary)
            .text('  •  ' + item, 50, doc.y, { width: PAGE_W, lineGap: 2, indent: 0 });
          doc.moveDown(0.15);
        });
      };

      // ═══════════════════════════════════════════════════════════════
      // PAGE 1: EXECUTIVE SUMMARY
      // ═══════════════════════════════════════════════════════════════

      // Title block
      doc.rect(40, 35, 515, 85).fill('#1e293b');
      doc.fontSize(22).font('Helvetica-Bold').fillColor('#ffffff')
        .text('UK Self-Employment Tax Report', 55, 48);
      doc.fontSize(11).font('Helvetica').fillColor('#94a3b8')
        .text('DB Cinema & Leo Adams — Camera Equipment Rental Business', 55, 75);
      doc.fontSize(9).fillColor('#64748b')
        .text(`Tax years 2022/23 through 2025/26  •  Generated ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`, 55, 95);
      doc.y = 135;

      heading('Executive Summary');
      doc.moveDown(0.2);

      // Summary boxes
      const gt = data.grandTotals;
      const boxY = doc.y;
      const boxH = 55;
      const boxW = PAGE_W / 3 - 6;

      // Box 1: No AIA
      doc.rect(50, boxY, boxW, boxH).fill('#fef2f2').stroke('#fca5a5');
      doc.fontSize(8).font('Helvetica').fillColor(COLORS.red).text('Total Owed (no AIA)', 55, boxY + 6, { width: boxW - 10 });
      doc.fontSize(18).font('Helvetica-Bold').text(fmt(gt.totalOwed), 55, boxY + 20, { width: boxW - 10 });
      doc.fontSize(7).font('Helvetica').fillColor(COLORS.grey).text(`Tax ${fmt(gt.totalTax)} + Penalties ${fmt(gt.totalPenalties)}`, 55, boxY + 42, { width: boxW - 10 });

      // Box 2: With AIA
      doc.rect(50 + boxW + 9, boxY, boxW, boxH).fill('#f0fdf4').stroke('#86efac');
      doc.fontSize(8).font('Helvetica').fillColor(COLORS.green).text('Total Owed (with AIA)', 55 + boxW + 9, boxY + 6, { width: boxW - 10 });
      doc.fontSize(18).font('Helvetica-Bold').text(fmt(gt.withAia.totalOwed), 55 + boxW + 9, boxY + 20, { width: boxW - 10 });
      doc.fontSize(7).font('Helvetica').fillColor(COLORS.grey).text('Assumes full equipment AIA claimed', 55 + boxW + 9, boxY + 42, { width: boxW - 10 });

      // Box 3: Deductions
      doc.rect(50 + (boxW + 9) * 2, boxY, boxW, boxH).fill('#eff6ff').stroke('#93c5fd');
      doc.fontSize(8).font('Helvetica').fillColor(COLORS.blue).text('Total Deductions Available', 55 + (boxW + 9) * 2, boxY + 6, { width: boxW - 10 });
      doc.fontSize(18).font('Helvetica-Bold').text(fmt(data.equipmentTotalValue + gt.totalHomeOfficeDeductions + gt.totalCapitalLosses), 55 + (boxW + 9) * 2, boxY + 20, { width: boxW - 10 });
      doc.fontSize(7).font('Helvetica').fillColor(COLORS.grey).text(`AIA ${fmt(data.equipmentTotalValue)} + Home ${fmt(gt.totalHomeOfficeDeductions)} + Loss ${fmt(gt.totalCapitalLosses)}`, 55 + (boxW + 9) * 2, boxY + 42, { width: boxW - 10 });

      doc.y = boxY + boxH + 15;

      // Per-year summary table
      subheading('Tax Year Overview');
      drawTable(
        ['Tax Year', 'Revenue', 'Deductions', 'Taxable (no AIA)', 'Tax (no AIA)', 'Tax (w/ AIA)', 'Penalties', 'Status'],
        [
          ...data.years.map((y: any) => [
            y.yearLabel,
            fmt(y.annualRevenue),
            '-' + fmt(y.deductions.totalOtherDeductions),
            fmt(y.noAia.taxableProfit),
            fmt(y.noAia.totalTax),
            fmt(y.withAia.totalTax),
            fmt(y.penalties.totalPenalties),
            ({ no_tax: 'No tax', current: 'Current', future: 'Not due', overdue: 'OVERDUE', urgent: 'ACT NOW' } as Record<string, string>)[y.status] || y.status,
          ]),
          ['TOTAL', fmt(data.years.reduce((s: number, y: any) => s + y.annualRevenue, 0)), '', '', fmt(gt.totalTax), fmt(gt.withAia.totalTax), fmt(gt.totalPenalties), ''],
        ],
        [62, 62, 62, 72, 62, 62, 58, 55],
        { highlightLast: true },
      );

      doc.moveDown(0.5);
      body('This report covers all UK tax obligations from the start of trading (August 2022) through the current tax year (2025/26). It includes two scenarios for each year: without AIA equipment write-offs (worst case) and with full AIA (best case).', 9);

      // ═══════════════════════════════════════════════════════════════
      // PAGE 2: KEY FINDINGS & URGENT ACTIONS
      // ═══════════════════════════════════════════════════════════════

      doc.addPage();
      heading('Key Findings & Urgent Actions');

      // Urgent callout
      const urgentYear = data.years.find((y: any) => y.status === 'urgent');
      if (urgentYear) {
        doc.rect(50, doc.y, PAGE_W, 50).fill('#fef3c7').stroke('#f59e0b');
        const calloutY = doc.y;
        doc.fontSize(11).font('Helvetica-Bold').fillColor(COLORS.amber)
          .text(`⚠ URGENT: ${urgentYear.yearLabel} — only ${urgentYear.penalties.filingDaysLate} days late`, 60, calloutY + 8, { width: PAGE_W - 20 });
        doc.fontSize(9).font('Helvetica').fillColor(COLORS.primary)
          .text('Filing now limits the penalty to £100. After 3 months late (late April 2026), daily £10 penalties begin accumulating up to £900 additional. Act immediately.', 60, calloutY + 24, { width: PAGE_W - 20 });
        doc.y = calloutY + 58;
      }

      doc.moveDown(0.3);
      subheading('Critical Penalty Discovery: Failure to Notify vs Late Filing');
      body('Since you never registered for Self Assessment, HMRC never issued you a "notice to file". This means you face "failure to notify" penalties (Schedule 41, Finance Act 2008) rather than standard late filing penalties. This is significantly better:', 9);
      doc.moveDown(0.3);

      drawTable(
        ['Penalty Type', 'How It Works', 'Your Likely Amount'],
        [
          ['Late Filing (does NOT apply)', 'Fixed: £100 + £10/day + surcharges', '£1,600/year × 3 = £4,800'],
          ['Failure to Notify (APPLIES)', '0-30% of unpaid tax (unprompted)', '0-30% of actual tax owed'],
          ['If AIA reduces tax to £0', 'Penalty = % of £0', '£0 penalty'],
        ],
        [140, 205, 150],
      );

      doc.moveDown(0.3);
      body('Key implication: If your equipment AIA claims reduce your taxable profit to zero for each year, the failure-to-notify penalty is also zero (it\'s a percentage of unpaid tax, not a fixed amount). The dashboard currently shows worst-case fixed penalties — your actual penalties will likely be much lower.', 9, COLORS.green);

      doc.moveDown(0.5);
      subheading('Recommended Immediate Actions');
      bulletList([
        'Sort all equipment purchase receipts by date — allocate each to the correct tax year (April 6 to April 5)',
        'Register for Self Assessment on GOV.UK immediately (form SA1 or online)',
        'Consider using HMRC\'s Digital Disclosure Service to make a voluntary "unprompted disclosure" — this qualifies you for the lowest penalty band (0-10% of unpaid tax for non-deliberate failures)',
        'File the 2024/25 return FIRST — it\'s only ~14 days late, limiting the penalty to £100 even under fixed penalty rules',
        'Engage a qualified accountant — they will prepare all returns, maximize deductions, and negotiate penalty reductions with HMRC',
        'File all outstanding returns as quickly as possible — interest accrues at ~7.75% per year on unpaid tax',
      ]);

      // ═══════════════════════════════════════════════════════════════
      // PAGE 3-4: DETAILED PER-YEAR BREAKDOWN
      // ═══════════════════════════════════════════════════════════════

      doc.addPage();
      heading('Detailed Per-Year Tax Breakdown');

      for (const yr of data.years as any[]) {
        checkPage(280);
        const statusLabel = ({ no_tax: 'No Tax Due', current: 'Current Year', future: 'Not Yet Due', overdue: 'OVERDUE', urgent: 'ACT NOW' } as Record<string, string>)[yr.status] || yr.status;
        const statusColor = ({ no_tax: COLORS.green, current: COLORS.blue, future: COLORS.grey, overdue: COLORS.red, urgent: COLORS.amber } as Record<string, string>)[yr.status] || COLORS.grey;

        // Year header bar
        doc.rect(50, doc.y, PAGE_W, 24).fill('#1e293b');
        doc.fontSize(13).font('Helvetica-Bold').fillColor('#ffffff')
          .text(yr.yearLabel, 58, doc.y + 5, { continued: true })
          .font('Helvetica').fontSize(10).fillColor(statusColor as string)
          .text(`    ${statusLabel}`, { continued: true })
          .fillColor('#94a3b8').text(`    (${yr.taxYearStart} to ${yr.taxYearEnd})`);
        doc.y += 10;
        doc.moveDown(0.4);

        // Revenue
        bodyBold(`Revenue: ${fmt(yr.annualRevenue)}${yr.projectedNote ? ' (' + yr.projectedNote + ', actual YTD: ' + fmt(yr.revenue) + ')' : ''}`, 10, COLORS.green);

        // Deductions
        if (yr.deductions.totalOtherDeductions > 0) {
          doc.moveDown(0.2);
          bodyBold('Deductions (always claimable):', 9);
          if (yr.deductions.homeOffice.deduction > 0) {
            body(`  Home office: -${fmt(yr.deductions.homeOffice.deduction)} (${yr.deductions.homeOffice.months} months × 30% of rent)`, 9, COLORS.blue);
          }
          for (const l of yr.deductions.capitalLosses) {
            body(`  Capital loss: -${fmt(l.amount)} (${l.description})`, 9, COLORS.purple);
          }
          body(`  Total other deductions: -${fmt(yr.deductions.totalOtherDeductions)}`, 9);
        }

        // No AIA scenario
        doc.moveDown(0.3);
        subheading('Scenario A: Without Equipment AIA', 10, COLORS.red);
        drawTable(
          ['Item', 'Amount'],
          [
            ['Gross revenue', fmt(yr.annualRevenue)],
            ['Less: home office & losses', '-' + fmt(yr.deductions.totalOtherDeductions)],
            ['Taxable profit', fmt(yr.noAia.taxableProfit)],
            ['Personal allowance', fmt(yr.noAia.personalAllowance)],
            ['Income Tax', fmt(yr.noAia.incomeTax)],
            ['Class 4 NIC', fmt(yr.noAia.class4NIC)],
            ...(yr.noAia.class2NIC > 0 ? [['Class 2 NIC', fmt(yr.noAia.class2NIC)]] : []),
            ['TOTAL TAX (no AIA)', fmt(yr.noAia.totalTax)],
          ],
          [300, 195],
          { highlightLast: true },
        );

        // Income tax bands detail
        if (yr.noAia.incomeTaxBands && yr.noAia.incomeTaxBands.length > 0) {
          body('  Income Tax bands: ' + yr.noAia.incomeTaxBands.map((b: any) => `${b.band} on ${fmt(b.taxable)} = ${fmt(b.tax)}`).join(', '), 8, COLORS.grey);
        }

        // With AIA scenario
        doc.moveDown(0.3);
        subheading('Scenario B: With Equipment AIA', 10, COLORS.green);
        drawTable(
          ['Item', 'Amount'],
          [
            ['Gross revenue', fmt(yr.annualRevenue)],
            ['Less: home office & losses', '-' + fmt(yr.deductions.totalOtherDeductions)],
            ['Less: equipment AIA', '-' + fmt(yr.withAia.aiaDeduction)],
            ['Taxable profit', fmt(yr.withAia.taxableProfit)],
            ['TOTAL TAX (with AIA)', fmt(yr.withAia.totalTax)],
          ],
          [300, 195],
          { highlightLast: true },
        );

        // Penalties
        if (yr.penalties.totalPenalties > 0 || yr.penalties.interest > 0) {
          doc.moveDown(0.3);
          subheading('Penalties & Interest', 10, COLORS.amber);
          body(`Filing deadline: ${yr.penalties.filingDeadline}  •  ${yr.penalties.filingDaysLate} days late`, 9, COLORS.grey);

          const penaltyRows: string[][] = [];
          for (const p of yr.penalties.filing.breakdown) {
            if (p.applies) penaltyRows.push([p.description, fmt(p.amount)]);
          }
          for (const p of yr.penalties.payment.breakdown) {
            if (p.applies) penaltyRows.push([p.description, fmt(p.amount)]);
          }
          if (yr.penalties.interest > 0) {
            penaltyRows.push(['Interest (7.75% annual on unpaid tax)', fmt(yr.penalties.interest)]);
          }
          penaltyRows.push(['TOTAL PENALTIES + INTEREST', fmt(yr.penalties.totalPenalties + yr.penalties.interest)]);

          drawTable(['Penalty', 'Amount'], penaltyRows, [350, 145], { highlightLast: true });

          // Note about failure to notify
          body('Note: Above shows FIXED filing penalties. If HMRC never issued a notice to file, actual penalty is "failure to notify" = 0-30% of unpaid tax. With AIA reducing tax to £0, this penalty would also be £0.', 8, COLORS.amber);
        }

        doc.moveDown(0.3);
        separator();
      }

      // ═══════════════════════════════════════════════════════════════
      // HOME OFFICE DEDUCTION DETAIL
      // ═══════════════════════════════════════════════════════════════

      doc.addPage();
      heading('Home Office Deduction — Detailed Analysis');

      subheading('Your Situation');
      bulletList([
        'You work from home managing your camera rental business (Hygglo listings, renter communication, booking management, delivery coordination)',
        'You rent a single room in shared accommodation — the room is used for both living and business (mixed use)',
        'Until 14 May 2025: £1,200/month rent',
        'From 15 May 2025: £1,700/month rent (not including side costs)',
        'Business use estimated at 30% (8-10 hours/day, 5-6 days/week managing the business)',
      ]);

      doc.moveDown(0.3);
      subheading('Method Comparison');
      drawTable(
        ['Method', 'How It Works', 'Annual Deduction', 'Recommendation'],
        [
          ['Simplified (flat rate)', '£26/month if 101+ hrs/mo', '£312/year', 'NOT recommended'],
          ['Actual cost (30%)', '30% of actual rent paid', '£4,300-6,100/year', 'RECOMMENDED'],
        ],
        [110, 160, 100, 125],
      );

      body('The actual cost method gives approximately 15-20x more deduction than the simplified flat rate. Since your rent is substantial (£1,200-1,700/month), this is by far the better option.', 9);
      doc.moveDown(0.3);

      subheading('Per-Year Home Office Deduction');
      drawTable(
        ['Tax Year', 'Months', 'Monthly Rent', 'Total Rent', '30% Deduction'],
        [
          ...data.years.map((y: any) => [
            y.yearLabel,
            y.deductions.homeOffice.months.toString(),
            y.deductions.homeOffice.totalRent > 0 ? fmt(Math.round(y.deductions.homeOffice.totalRent / y.deductions.homeOffice.months)) : '£0',
            fmt(y.deductions.homeOffice.totalRent),
            '-' + fmt(y.deductions.homeOffice.deduction),
          ]),
          ['TOTAL', '', '', fmt(data.years.reduce((s: number, y: any) => s + y.deductions.homeOffice.totalRent, 0)), '-' + fmt(gt.totalHomeOfficeDeductions)],
        ],
        [80, 60, 90, 100, 165],
        { highlightLast: true },
      );

      doc.moveDown(0.5);
      subheading('Legal Basis & HMRC Guidance');
      bulletList([
        'HMRC allows self-employed individuals to deduct a proportion of household costs when working from home (GOV.UK/expenses-if-youre-self-employed)',
        'The actual cost method calculates business proportion based on TIME used for business vs total hours',
        '30% is a reasonable and defensible proportion for someone spending 8-10 hours/day, 5-6 days/week on business',
        'Since you rent a single room (not an entire property), the room proportion is already 100% — only time proportion applies',
        'You can switch between simplified and actual cost methods at the start of each tax year',
        'Mixed-use rooms ARE allowed — you don\'t need a dedicated office',
        'As a renter (not homeowner), there is NO Capital Gains Tax risk from claiming business use',
        'These deductions CAN be claimed retroactively on overdue tax returns',
      ]);

      doc.moveDown(0.5);
      subheading('Considerations');

      doc.moveDown(0.2);
      bodyBold('Positives:', 9, COLORS.green);
      bulletList([
        'Saves £18,050 total across all years compared to claiming nothing',
        'Saves ~£14,700 more than the simplified flat rate method (£312/year)',
        'Completely legal — this is standard HMRC practice for self-employed individuals',
        'Reduces taxable profit in every year, which also reduces any failure-to-notify penalties',
        'No receipts needed beyond your rent agreement/bank statements showing rent payments',
      ]);

      doc.moveDown(0.2);
      bodyBold('Risks & Limitations:', 9, COLORS.red);
      bulletList([
        '30% could be challenged by HMRC if you can\'t demonstrate sufficient business hours — keep a log of typical working hours',
        'The deduction only covers rent — you could also claim 30% of utilities (electricity, internet, heating) if you have the bills',
        'HMRC may query the proportion on an overdue return — having records strengthens your position',
        'The simplified method (£312/year) is bulletproof but gives minimal relief — use it only as a fallback if 30% is challenged',
      ]);

      // ═══════════════════════════════════════════════════════════════
      // CAPITAL ALLOWANCES (AIA) STRATEGY
      // ═══════════════════════════════════════════════════════════════

      doc.addPage();
      heading('Equipment Write-Off (AIA) — Strategy');

      subheading('Annual Investment Allowance (AIA)');
      body('The AIA allows 100% first-year deduction on business equipment (plant & machinery). The current limit is £1,000,000/year — your total equipment of ' + fmt(data.equipmentTotalValue) + ' is well within this.', 9);

      doc.moveDown(0.3);
      subheading('Critical Rule: AIA Must Be Claimed in Year of Purchase');
      doc.rect(50, doc.y, PAGE_W, 45).fill('#fef3c7').stroke('#f59e0b');
      const aiaWarnY = doc.y;
      doc.fontSize(9).font('Helvetica-Bold').fillColor(COLORS.amber)
        .text('IMPORTANT: You cannot lump all equipment onto one return.', 60, aiaWarnY + 6, { width: PAGE_W - 20 });
      doc.fontSize(8).font('Helvetica').fillColor(COLORS.primary)
        .text('Section 51A(2) Capital Allowances Act 2001 requires AIA to be claimed in the tax year the expenditure was incurred. Each item must go on the return for the year it was purchased. This is "use it or lose it" — unused AIA cannot be carried forward.', 60, aiaWarnY + 20, { width: PAGE_W - 20 });
      doc.y = aiaWarnY + 55;

      doc.moveDown(0.3);
      subheading('Can You Still Claim Retroactively?');
      bodyBold('YES — all years are within the 4-year statutory window.', 10, COLORS.green);
      doc.moveDown(0.2);

      drawTable(
        ['Tax Year', '4-Year Deadline', 'Status', 'Time Remaining'],
        [
          ['2022/23', '5 April 2027', 'WITHIN TIME', '14 months'],
          ['2023/24', '5 April 2028', 'WITHIN TIME', '26 months'],
          ['2024/25', '5 April 2029', 'WITHIN TIME', '38 months'],
          ['2025/26', '5 April 2030', 'WITHIN TIME', '50 months'],
        ],
        [100, 120, 120, 155],
      );

      body('Filing a late return is valid as long as it\'s within 4 years of the tax year end (Section 34A TMA 1970). The AIA claim is simply included on the return. HMRC must process it.', 9);

      doc.moveDown(0.5);
      subheading('Equipment Allocation Strategy');
      body('To maximize tax savings, allocate equipment purchases to the year with the highest taxable profit after other deductions. Here is each year\'s "gap" that needs AIA coverage:', 9);
      doc.moveDown(0.2);

      drawTable(
        ['Tax Year', 'Revenue', 'Other Deductions', 'Profit Before AIA', 'AIA Needed to Zero Tax'],
        data.years.map((y: any) => {
          const profitBeforeAia = Math.max(0, y.annualRevenue - y.deductions.totalOtherDeductions);
          const aiaNeedToZero = Math.max(0, profitBeforeAia - 12570); // below personal allowance = no tax
          return [
            y.yearLabel,
            fmt(y.annualRevenue),
            '-' + fmt(y.deductions.totalOtherDeductions),
            fmt(profitBeforeAia),
            aiaNeedToZero > 0 ? fmt(aiaNeedToZero) : '£0 (below PA)',
          ];
        }),
        [80, 85, 95, 105, 130],
      );

      doc.moveDown(0.3);
      body('Personal allowance is £12,570 — any profit below this threshold means no tax is owed regardless of AIA. You only need enough AIA in each year to bring the taxable profit below £12,570.', 9, COLORS.blue);

      doc.moveDown(0.3);
      subheading('Fallback: Writing Down Allowances (WDA)');
      body('If any items can\'t be allocated to the correct purchase year (e.g., missing receipts), they can still be claimed via WDA at 18%/year on a reducing balance basis. This is slower but the value is not lost.', 9);

      // ═══════════════════════════════════════════════════════════════
      // CAMERA LOSS & DZO LENSES
      // ═══════════════════════════════════════════════════════════════

      doc.addPage();
      heading('Specific Items: Camera Loss & DZO Lenses');

      subheading('Camera Sold at £4,500 Loss (2024/25)');
      body('A camera was purchased for the rental business, never successfully rented out, and sold at a £4,500 loss.', 9);
      doc.moveDown(0.3);

      drawTable(
        ['Item', 'Detail'],
        [
          ['Purchase purpose', 'Business inventory (camera rental)'],
          ['Rental activity', 'None — item never rented'],
          ['Loss on sale', '£4,500'],
          ['Tax year', '2024/25 (bought and sold same year)'],
          ['Tax treatment', 'Fully deductible business loss'],
          ['Effect on 2024/25 tax', 'Reduces taxable profit by £4,500'],
        ],
        [180, 315],
      );

      doc.moveDown(0.3);
      bodyBold('Positives:', 9, COLORS.green);
      bulletList([
        'The £4,500 loss is fully deductible as a business expense — the camera was purchased with genuine business intent',
        'The fact it never rented does not disqualify it — business losses on failed inventory are normal',
        'In 2024/25 (your highest revenue year), this deduction is worth ~£1,200 in tax savings at the basic+NIC rate',
        'Can be claimed alongside AIA for other equipment in the same year',
      ]);

      bodyBold('Negatives / Risks:', 9, COLORS.red);
      bulletList([
        'If the camera was also used personally, HMRC could argue only the business-use portion is deductible',
        'You need proof of purchase price and sale price (receipts, bank statements)',
        'If AIA already reduces your 2024/25 tax to zero, the additional £4,500 loss doesn\'t save anything extra (but can be carried forward)',
      ]);

      separator();

      subheading('DZO Lenses: Stolen, Insurance Payout Exceeded Cost');
      body('DZO lenses with a cost of £5,200 were stolen. Insurance paid out £6,000.', 9);
      doc.moveDown(0.3);

      drawTable(
        ['Component', 'Amount', 'Tax Treatment'],
        [
          ['Original purchase cost', '£5,200', 'Claimed via AIA (100% deduction)'],
          ['Insurance payout received', '£6,000', 'See breakdown below'],
          ['Disposal value (capital allowances)', '£5,200', 'Capped at original cost per s.62 CAA 2001'],
          ['Balancing charge', '£5,200', 'Added back to taxable income (claws back AIA)'],
          ['Excess over cost', '£800', 'Falls under Capital Gains Tax'],
          ['CGT annual exempt amount', '£3,000-12,300', 'Covers the £800 gain — £0 CGT'],
          ['NET TAX EFFECT', 'TAX-NEUTRAL', 'AIA given then clawed back; £800 excess CGT-free'],
        ],
        [155, 100, 240],
        { highlightLast: true },
      );

      doc.moveDown(0.3);
      bodyBold('How it works step by step:', 9);
      bulletList([
        'Year of purchase: £5,200 claimed as AIA (reduces taxable profit by £5,200) ✓',
        'Year of theft/insurance: disposal value = £5,200 (CAPPED at original cost, even though payout was £6,000)',
        'Balancing charge of £5,200 is added back to taxable profit (cancels the original AIA deduction)',
        'The £800 excess (£6,000 - £5,200) is subject to CGT, not income tax',
        'But £800 is within the CGT annual exempt amount (£3,000 minimum) → £0 CGT',
        'If replacement equipment was bought within 12 months: rollover relief under s.23(4) TCGA 1992 eliminates even the CGT question',
      ]);

      doc.moveDown(0.2);
      bodyBold('Bottom line:', 10, COLORS.green);
      body('You keep the £800 profit completely tax-free. The rest washes out (AIA given, then clawed back via balancing charge). If you purchased replacement lenses, claim AIA on the new ones.', 9);

      // ═══════════════════════════════════════════════════════════════
      // PENALTY ANALYSIS
      // ═══════════════════════════════════════════════════════════════

      doc.addPage();
      heading('Penalty Analysis — Two Scenarios');

      subheading('Scenario 1: Standard Late Filing Penalties (Worst Case)');
      body('This applies IF HMRC had issued you a notice to file. The dashboard currently shows these numbers:', 9);
      doc.moveDown(0.2);

      const penaltyWCRows: string[][] = [];
      for (const yr of data.years as any[]) {
        if (yr.penalties.totalPenalties > 0 || yr.penalties.interest > 0) {
          penaltyWCRows.push([
            yr.yearLabel,
            yr.penalties.filingDaysLate + ' days',
            fmt(yr.penalties.filing.total),
            fmt(yr.penalties.payment.total),
            fmt(yr.penalties.interest),
            fmt(yr.penalties.totalPenalties + yr.penalties.interest),
          ]);
        }
      }
      penaltyWCRows.push(['TOTAL', '', '', '', '', fmt(gt.totalPenalties + gt.totalInterest)]);

      drawTable(
        ['Year', 'Days Late', 'Filing', 'Payment', 'Interest', 'Total'],
        penaltyWCRows,
        [70, 65, 90, 90, 90, 90],
        { highlightLast: true },
      );

      doc.moveDown(0.5);
      subheading('Scenario 2: Failure to Notify Penalties (Likely Actual)');
      body('This applies when you never registered for Self Assessment (HMRC never issued a notice to file). The penalty is a PERCENTAGE of unpaid tax, not a fixed amount.', 9);
      doc.moveDown(0.2);

      drawTable(
        ['Year', 'Tax (no AIA)', 'Tax (w/ AIA)', 'Penalty Range', 'Penalty (no AIA)', 'Penalty (w/ AIA)'],
        data.years.filter((y: any) => y.penalties.filingDaysLate > 0).map((yr: any) => {
          const noAiaPenMin = Math.round(yr.noAia.totalTax * 0.10);
          const noAiaPenMax = Math.round(yr.noAia.totalTax * 0.30);
          return [
            yr.yearLabel,
            fmt(yr.noAia.totalTax),
            fmt(yr.withAia.totalTax),
            '10-30% of tax',
            yr.noAia.totalTax > 0 ? `${fmt(noAiaPenMin)}-${fmt(noAiaPenMax)}` : '£0',
            yr.withAia.totalTax > 0 ? `${fmt(Math.round(yr.withAia.totalTax * 0.10))}-${fmt(Math.round(yr.withAia.totalTax * 0.30))}` : '£0',
          ];
        }),
        [60, 75, 75, 80, 100, 105],
      );

      doc.moveDown(0.3);
      body('With an unprompted, non-deliberate disclosure and AIA reducing tax to £0, the failure-to-notify penalty would be £0 for every year. Even without AIA, the penalties are proportional to tax owed — not the fixed £1,600/year shown in the worst case.', 9, COLORS.green);

      doc.moveDown(0.5);
      subheading('Comparison of Total Liability');
      const noAiaPenaltyMin = data.years.reduce((s: number, y: any) => s + Math.round(y.noAia.totalTax * 0.10), 0);
      const noAiaPenaltyMax = data.years.reduce((s: number, y: any) => s + Math.round(y.noAia.totalTax * 0.30), 0);
      drawTable(
        ['Scenario', 'Tax', 'Penalties', 'Interest', 'TOTAL'],
        [
          ['Worst case (fixed penalties, no AIA)', fmt(gt.totalTax), fmt(gt.totalPenalties), fmt(gt.totalInterest), fmt(gt.totalOwed)],
          ['No AIA + failure-to-notify', fmt(gt.totalTax), `${fmt(noAiaPenaltyMin)}-${fmt(noAiaPenaltyMax)}`, fmt(gt.totalInterest), `${fmt(gt.totalTax + noAiaPenaltyMin + gt.totalInterest)}-${fmt(gt.totalTax + noAiaPenaltyMax + gt.totalInterest)}`],
          ['With AIA + failure-to-notify', fmt(gt.withAia.totalTax), '£0', '£0', fmt(gt.withAia.totalTax)],
          ['BEST CASE (AIA + voluntary disclosure)', '£0', '£0', '£0', '£0'],
        ],
        [185, 80, 80, 70, 80],
        { highlightLast: true },
      );

      doc.moveDown(0.3);
      body('The best-case scenario (full AIA coverage + voluntary unprompted disclosure) results in £0 total liability. This requires allocating sufficient equipment purchases to each tax year to cover the taxable profit.', 9, COLORS.green);

      // ═══════════════════════════════════════════════════════════════
      // TIMELINE & DEADLINES
      // ═══════════════════════════════════════════════════════════════

      doc.addPage();
      heading('Important Deadlines & Timeline');

      drawTable(
        ['Date', 'Event', 'Action Required'],
        [
          ['31 Jan 2024', '2022/23 filing deadline (PASSED)', 'File now — within 4-year window until Apr 2027'],
          ['31 Jan 2025', '2023/24 filing deadline (PASSED)', 'File now — within 4-year window until Apr 2028'],
          ['31 Jan 2026', '2024/25 filing deadline (PASSED)', 'URGENT — only ~14 days late, file immediately'],
          ['Late Apr 2026', '2024/25: 3-month penalty threshold', 'If not filed by then, £10/day penalties begin'],
          ['31 Jul 2026', '2024/25: 6-month penalty threshold', '5% surcharge on unpaid tax applies'],
          ['31 Jan 2027', '2025/26 filing deadline', 'File on time to avoid any penalties for current year'],
          ['5 Apr 2027', '2022/23: 4-year statutory deadline', 'LAST CHANCE to file 2022/23 return with AIA claims'],
        ],
        [90, 190, 215],
      );

      doc.moveDown(0.5);
      heading('Summary of All Deductions Available');

      drawTable(
        ['Deduction Type', 'Total Value', 'Applies To', 'Notes'],
        [
          ['Equipment AIA', fmt(data.equipmentTotalValue), 'Year of purchase', 'Must allocate by actual purchase date'],
          ['Home office (30% rent)', fmt(gt.totalHomeOfficeDeductions), 'Every year', 'Actual cost method — always claimable'],
          ['Camera capital loss', fmt(gt.totalCapitalLosses), '2024/25 only', 'Bought & sold same year at £4,500 loss'],
          ['DZO lenses insurance', 'Tax-neutral', 'N/A', '£800 profit CGT-exempt; AIA clawed back'],
          ['TOTAL (excl. DZO)', fmt(data.equipmentTotalValue + gt.totalHomeOfficeDeductions + gt.totalCapitalLosses), 'All years', 'Split across years per purchase dates'],
        ],
        [120, 90, 90, 195],
        { highlightLast: true },
      );

      doc.moveDown(0.8);

      // Disclaimer
      doc.rect(50, doc.y, PAGE_W, 60).fill('#f8fafc').stroke(COLORS.tableBorder);
      const discY = doc.y;
      doc.fontSize(8).font('Helvetica-Bold').fillColor(COLORS.grey)
        .text('DISCLAIMER', 60, discY + 6, { width: PAGE_W - 20 });
      doc.fontSize(7).font('Helvetica').fillColor(COLORS.lightGrey)
        .text('This report is generated automatically for informational purposes only. It does not constitute professional tax advice. Tax calculations are estimates based on available data and UK tax rates as of February 2026. Actual tax liability may differ based on individual circumstances, HMRC interpretation, and factors not captured in this system. You should consult a qualified accountant or tax adviser before filing any tax returns. The penalty analysis assumes non-deliberate behaviour and unprompted disclosure — HMRC may assess penalties differently.', 60, discY + 18, { width: PAGE_W - 20, lineGap: 1 });

      doc.end();
    });
  }
}
