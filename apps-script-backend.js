// =====================================================================
// COFFEE CART — Google Apps Script Backend v5
// =====================================================================
// SHEET TABS REQUIRED: SalesReports | StockLevels | ReorderLog
// SCRIPT PROPERTIES:   SHEET_ID = your Google Sheet ID
// DEPLOY AS:           Web App — Execute as Me, access Anyone
// =====================================================================

// ── Spreadsheet access ────────────────────────────────
function getSpreadsheet(){
  const id=PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if(!id) throw new Error('SHEET_ID not set in Script Properties');
  return SpreadsheetApp.openById(id);
}

function getOrCreateSheet(ss,name,headers){
  let sheet=ss.getSheetByName(name);
  if(!sheet){
    sheet=ss.insertSheet(name);
    if(headers&&headers.length){
      sheet.appendRow(headers);
      sheet.getRange(1,1,1,headers.length).setFontWeight('bold').setBackground('#f0f0f0');
    }
  }
  return sheet;
}

// ── Column definitions ────────────────────────────────
// SalesReports columns (1-based for sheet, 0-based index for parsing).
// IMPORTANT: these are the ONLY columns written and read.
// Any change here must be reflected in both the writer and the reader.
const SR_HEADERS=[
  'Timestamp',        // 0
  'Date',             // 1
  'Event Name',       // 2
  'Location',         // 3
  'Completed By',     // 4
  'Row Type',         // 5  — STAFF | SALES | SALES_TOTAL | STOCK_USED | FRIDGE | NOTES
  'Staff Name',       // 6
  'Staff Start',      // 7
  'Staff End',        // 8
  'Staff Hours',      // 9
  'Product',          // 10
  'Qty Sold',         // 11
  'Cash Sales',       // 12
  'Eftpos Sales',     // 13
  'Total Sales',      // 14
  'Stock Item',       // 15
  'Stock Qty Used',   // 16
  'Fridge Time',      // 17
  'Fridge Temp (C)',  // 18
  'Issues',           // 19
  'Notes'             // 20
];
// Named indices (matches SR_HEADERS above)
const I={
  ts:0,date:1,event:2,loc:3,by:4,type:5,
  sName:6,sStart:7,sEnd:8,sHrs:9,
  prod:10,qty:11,
  cash:12,eftpos:13,total:14,
  stItem:15,stQty:16,
  fTime:17,fTemp:18,
  issues:19,notes:20
};
const SR_WIDTH=SR_HEADERS.length; // 21

const SL_HEADERS=['Item','Current Level','Last Updated'];
const RL_HEADERS=['Date','Supplier','Item','Qty','Cost Per Unit','Total Cost','Logged At'];

// ═══════════════════════════════════════════════════════
// ROUTING
// ═══════════════════════════════════════════════════════
function doPost(e){
  try{
    const p=(e.parameters||{});
    const action=(p.action||['salesReport'])[0];
    if(action==='reorder')     return handleReorder(p);
    if(action==='updateStock') return handleUpdateStock(p);
    if(action==='salesReport') return handleSalesReport(p);
    throw new Error('Unknown action: '+action);
  }catch(err){ return jsonResp({success:false,error:err.toString()}); }
}

function doGet(e){
  try{
    const action=(e.parameter||{}).action||'';
    if(action==='getStock')  return handleGetStock();
    if(action==='dashboard') return handleDashboard();
    return jsonResp({success:false,error:'Unknown GET action: '+action});
  }catch(err){ return jsonResp({success:false,error:err.toString()}); }
}

// ═══════════════════════════════════════════════════════
// SALES REPORT
// Writes one row per data element, using explicit column
// placement (blank array of SR_WIDTH, then set by index).
// This guarantees the dashboard parser always finds data
// in the expected column regardless of how many fields
// any given row type uses.
// ═══════════════════════════════════════════════════════
function handleSalesReport(p){
  const ss    = getSpreadsheet();
  const sheet = getOrCreateSheet(ss,'SalesReports',SR_HEADERS);
  const ts    = new Date().toISOString();

  const gp=(key,i)=>((p[key]||[])[i]||'');
  const date  = gp('date',0);
  const event = gp('eventName',0);
  const loc   = gp('location',0);
  const by    = gp('completedBy',0);

  // Build a blank row and fill named columns
  function row(type,fields){
    const r=new Array(SR_WIDTH).fill('');
    r[I.ts]=ts; r[I.date]=date; r[I.event]=event; r[I.loc]=loc; r[I.by]=by;
    r[I.type]=type;
    Object.entries(fields).forEach(([k,v])=>{ if(I[k]!==undefined) r[I[k]]=v; });
    return r;
  }

  // Staff rows
  (p['staffName[]']||[]).forEach((name,i)=>{
    const start=gp('staffStart[]',i), end=gp('staffEnd[]',i);
    sheet.appendRow(row('STAFF',{sName:name,sStart:start,sEnd:end,sHrs:calcHrs(start,end)}));
  });

  // Sales rows (one per product)
  (p['saleProduct[]']||[]).forEach((prod,i)=>{
    sheet.appendRow(row('SALES',{prod:prod,qty:gp('saleQty[]',i)}));
  });

  // Sales totals row
  sheet.appendRow(row('SALES_TOTAL',{cash:gp('cashSales',0),eftpos:gp('eftposSales',0),total:gp('totalSales',0)}));

  // Stock used rows + deduct from StockLevels
  (p['stockItem[]']||[]).forEach((item,i)=>{
    const qty=parseFloat(gp('stockQty[]',i))||0;
    sheet.appendRow(row('STOCK_USED',{stItem:item,stQty:qty}));
    if(qty>0) deductStock(ss,item,qty);
  });

  // Fridge readings
  (p['fridgeTime[]']||[]).forEach((time,i)=>{
    sheet.appendRow(row('FRIDGE',{fTime:time,fTemp:gp('fridgeTemp[]',i)}));
  });

  // Notes row (only if content present)
  const issues=gp('issues',0), notes=gp('notes',0);
  if(issues||notes) sheet.appendRow(row('NOTES',{issues:issues,notes:notes}));

  return jsonResp({success:true});
}

// ═══════════════════════════════════════════════════════
// GET STOCK — returns current stock levels + reorder log
// ═══════════════════════════════════════════════════════
function handleGetStock(){
  const ss    = getSpreadsheet();
  const sheet = getOrCreateSheet(ss,'StockLevels',SL_HEADERS);
  const rows  = sheet.getDataRange().getValues();
  const stock = {};
  for(let i=1;i<rows.length;i++){
    const[item,level]=rows[i];
    if(item) stock[String(item)]=(level!==''?parseFloat(level):null);
  }
  return jsonResp({success:true,stock:stock,reorderLog:buildReorderLog(ss)});
}

function buildReorderLog(ss){
  const sheet = getOrCreateSheet(ss,'ReorderLog',RL_HEADERS);
  const rows  = sheet.getDataRange().getValues();
  const map   = {};
  for(let i=1;i<rows.length;i++){
    const[date,supplier,item,qty,cpu,totalCost]=rows[i];
    const key=`${date}||${supplier}`;
    if(!map[key]) map[key]={date:String(date).slice(0,10),supplier:String(supplier),items:[],totalCost:0};
    map[key].items.push({item:String(item),qty:parseFloat(qty)||0,costPerUnit:parseFloat(cpu)||0});
    map[key].totalCost+=parseFloat(totalCost)||0;
  }
  return Object.values(map).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,30);
}

// ═══════════════════════════════════════════════════════
// REORDER — log purchase and add to stock
// ═══════════════════════════════════════════════════════
function handleReorder(p){
  const ss     = getSpreadsheet();
  const rl     = getOrCreateSheet(ss,'ReorderLog',RL_HEADERS);
  const sl     = getOrCreateSheet(ss,'StockLevels',SL_HEADERS);
  const ts     = new Date().toISOString();
  const date   = (p.date    ||[todaySrv()])[0];   // actual date — no duplicate append bug
  const supplier=(p.supplier||[''])[0];
  (p['item[]']||[]).forEach((item,i)=>{
    const qty=parseFloat((p['qty[]']        ||[])[i])||0;
    const cpu=parseFloat((p['costPerUnit[]']||[])[i])||0;
    if(!item||qty<=0) return;
    rl.appendRow([date,supplier,item,qty,cpu,Math.round(qty*cpu*100)/100,ts]);
    addToStock(sl,item,qty);
  });
  return jsonResp({success:true});
}

// ═══════════════════════════════════════════════════════
// UPDATE STOCK — manual level override from app
// ═══════════════════════════════════════════════════════
function handleUpdateStock(p){
  const ss    = getSpreadsheet();
  const sheet = getOrCreateSheet(ss,'StockLevels',SL_HEADERS);
  (p['item[]']||[]).forEach((item,i)=>{
    const qty=parseFloat((p['qty[]']||[])[i]);
    if(item) setStockLevel(sheet,item,isNaN(qty)?0:qty);
  });
  return jsonResp({success:true});
}

// ── StockLevels helpers ───────────────────────────────
function stockRowNum(sheet,item){
  const rows=sheet.getDataRange().getValues();
  for(let i=1;i<rows.length;i++) if(String(rows[i][0])===String(item)) return i+1;
  return -1;
}
function setStockLevel(sheet,item,val){
  const r=stockRowNum(sheet,item),now=new Date().toISOString();
  if(r>0){sheet.getRange(r,2).setValue(val);sheet.getRange(r,3).setValue(now);}
  else sheet.appendRow([item,val,now]);
}
function addToStock(sheet,item,qty){
  const r=stockRowNum(sheet,item),now=new Date().toISOString();
  if(r>0){
    const cur=parseFloat(sheet.getRange(r,2).getValue())||0;
    sheet.getRange(r,2).setValue(Math.round((cur+qty)*1000)/1000);
    sheet.getRange(r,3).setValue(now);
  } else sheet.appendRow([item,qty,now]);
}
function deductStock(ss,item,qty){
  const sheet=getOrCreateSheet(ss,'StockLevels',SL_HEADERS);
  const r=stockRowNum(sheet,item);
  if(r>0){
    const cur=parseFloat(sheet.getRange(r,2).getValue())||0;
    sheet.getRange(r,2).setValue(Math.max(0,Math.round((cur-qty)*1000)/1000));
    sheet.getRange(r,3).setValue(new Date().toISOString());
  }
}

// ═══════════════════════════════════════════════════════
// DASHBOARD
// Parses SalesReports using named column indices (I.*).
// Returns allEvents[] — each event contains:
//   date, eventName, location, completedBy,
//   totalSales (number), cashSales, eftposSales,
//   staff[]     [{name, start, end, hours}]
//   sales[]     [{product, qty}]
//   stockUsed[] [{item, qty}]
//   equipmentIssues, notes,
//   staffCost  (hours × $30, rounded to 2dp)
//   stockCost  (qty × most-recent reorder CPU, rounded to 2dp)
// ═══════════════════════════════════════════════════════
function handleDashboard(){
  const ss    = getSpreadsheet();
  const sheet = getOrCreateSheet(ss,'SalesReports',SR_HEADERS);
  const rows  = sheet.getDataRange().getValues();

  // Most-recent cost per unit per stock item (last row wins = most recent)
  const cpuMap=getMostRecentCosts(ss);

  const eventMap={};

  for(let i=1;i<rows.length;i++){
    const r     = rows[i];
    const date  = String(r[I.date]).slice(0,10);
    const ename = String(r[I.event]);
    const type  = String(r[I.type]);
    if(!date||!ename) continue;  // skip malformed rows

    const key=`${date}||${ename}`;
    if(!eventMap[key]){
      eventMap[key]={
        date:date, eventName:ename,
        location:String(r[I.loc]),
        completedBy:String(r[I.by]),
        totalSales:0, cashSales:'', eftposSales:'',
        staff:[], sales:[], stockUsed:[],
        equipmentIssues:'', notes:'',
        staffCost:0, stockCost:0
      };
    }
    const ev=eventMap[key];

    if(type==='STAFF'&&r[I.sName]){
      const hrs=parseFloat(r[I.sHrs])||0;
      ev.staff.push({name:String(r[I.sName]),start:String(r[I.sStart]),end:String(r[I.sEnd]),hours:hrs});
      ev.staffCost+=hrs*30;
    }
    if(type==='SALES'&&r[I.prod]){
      ev.sales.push({product:String(r[I.prod]),qty:parseFloat(r[I.qty])||0});
    }
    if(type==='SALES_TOTAL'){
      ev.totalSales  =parseFloat(r[I.total])||0;
      ev.cashSales   =String(r[I.cash]);
      ev.eftposSales =String(r[I.eftpos]);
    }
    if(type==='STOCK_USED'&&r[I.stItem]){
      const qty=parseFloat(r[I.stQty])||0;
      const item=String(r[I.stItem]);
      ev.stockUsed.push({item:item,qty:qty});
      ev.stockCost+=qty*(cpuMap[item]||0);
    }
    if(type==='NOTES'){
      ev.equipmentIssues=String(r[I.issues]||'');
      ev.notes          =String(r[I.notes] ||'');
    }
  }

  const allEvents=Object.values(eventMap).map(ev=>({
    ...ev,
    staffCost:Math.round(ev.staffCost*100)/100,
    stockCost:Math.round(ev.stockCost*100)/100
  }));

  return jsonResp({success:true,allEvents:allEvents});
}

// Build item→CPU map from ReorderLog; later rows overwrite earlier (most recent wins)
function getMostRecentCosts(ss){
  const sheet=getOrCreateSheet(ss,'ReorderLog',RL_HEADERS);
  const rows=sheet.getDataRange().getValues();
  const map={};
  for(let i=1;i<rows.length;i++){
    const item=String(rows[i][2]);
    const cpu=parseFloat(rows[i][4]);
    if(item&&!isNaN(cpu)&&cpu>0) map[item]=cpu;
  }
  return map;
}

// ═══════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════
function jsonResp(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function calcHrs(start,end){
  if(!start||!end) return '';
  const[sh,sm]=start.split(':').map(Number),[eh,em]=end.split(':').map(Number);
  let d=new Date(0,0,0,eh,em)-new Date(0,0,0,sh,sm);
  if(d<0) d+=86400000;
  return Math.round(d/3600000*100)/100;
}

function todaySrv(){
  return Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyy-MM-dd');
}
