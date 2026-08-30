// Fixture page for the CarbonTable engine, driven by scripts/dev-table.mjs.
// Runs OUTSIDE a bench: no frappe global, no jQuery, no desk bundle. That is the
// point — it proves the engine has no hidden dependency on the desk, and it is
// where engine behaviour is exercised before any adapter exists.
import CarbonTable from "../carbon_frappe/public/js/tables/engine/table";

const FIRST = ["Ada", "Grace", "Alan", "Edsger", "Barbara", "Donald", "Ken", "Dennis"];
const LAST = ["Lovelace", "Hopper", "Turing", "Dijkstra", "Liskov", "Knuth", "Thompson", "Ritchie"];
const STATUS = ["Draft", "Submitted", "Billed", "Cancelled"];

function makeData(n) {
	const rows = [];
	for (let i = 0; i < n; i++) {
		rows.push({
			name: `ROW-${String(i + 1).padStart(5, "0")}`,
			first: FIRST[i % FIRST.length],
			last: LAST[(i * 3) % LAST.length],
			status: STATUS[i % STATUS.length],
			qty: ((i * 7919) % 500) / 10,
			rate: ((i * 104729) % 100000) / 100,
			project: `Project ${String.fromCharCode(65 + (i % 26))}`,
			task: `Task ${(i % 40) + 1}`,
			note: `Line item ${i + 1} — description text that overflows the cell`,
		});
	}
	return rows;
}

const columns = [
	{ id: "name", label: "ID", size: 160, pinned: "start" },
	{ id: "first", label: "First Name", size: 140 },
	{ id: "last", label: "Last Name", size: 160 },
	{
		id: "status",
		label: "Status",
		size: 130,
		cell: (ctx) => `<span class="pill pill-${String(ctx.value).toLowerCase()}">${ctx.value}</span>`,
	},
	{ id: "qty", label: "Qty", size: 100, align: "right" },
	{ id: "rate", label: "Rate", size: 130, align: "right", cell: (ctx) => ctx.value.toFixed(2) },
	{ id: "project", label: "Project", size: 160 },
	{ id: "task", label: "Task", size: 140 },
	{ id: "note", label: "Note", size: 380 },
	{ id: "extra1", label: "Extra 1", size: 120, accessor: (r) => r.qty * 2 },
	{ id: "extra2", label: "Extra 2", size: 120, accessor: (r) => r.rate * 2 },
	{ id: "extra3", label: "Extra 3", size: 120, accessor: (r) => r.qty + r.rate },
	{ id: "actions", label: "Actions", size: 110, pinned: "end", sortable: false, filterable: false, cell: () => `<button class="row-action" type="button">Open</button>` },
];

const table = new CarbonTable(document.getElementById("host"), {
	columns,
	data: makeData(Number(new URLSearchParams(location.search).get("rows") || 500)),
	getRowId: (r) => r.name,
	rowHeight: 48,
	inlineFilters: true,
	selectable: true,
	showTotalRow: true,
	emptyMessage: "No matching entries",
	renderTotal: (entry, column, colIndex, host) => {
		if (column.id !== "qty" && column.id !== "rate") {
			host.applyContent(entry, entry.content, colIndex === 0 ? "Total" : "");
			return;
		}
		let sum = 0;
		for (const row of host.table.getRowModel().rows) sum += Number(row.getValue(column.id)) || 0;
		host.applyContent(entry, entry.content, sum.toFixed(2));
	},
});

// Expose for the CDP driver to assert against.
window.demo = { table, makeData };
