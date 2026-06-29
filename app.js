// KONFIGURASI SUPABASE
const SUPABASE_URL = 'https://grguwialhmpvssqksgdp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdyZ3V3aWFsaG1wdnNzcWtzZ2RwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2OTcwNzIsImV4cCI6MjA5ODI3MzA3Mn0.NJaM9KzjnuOzKFpl93fzUoJ9ZIYkzP0qVXXKuZFbgc8';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let currentUser = null;

const formatRupiah = (num) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(num || 0);

// LOGIN
document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const email = `${username}@percetakan.com`;

    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    
    if (error) {
        const errDiv = document.getElementById('login-error');
        errDiv.textContent = 'Login gagal: ' + error.message;
        errDiv.classList.remove('hidden');
    } else {
        currentUser = { username, id: data.user.id };
        document.getElementById('login-view').classList.add('hidden-view');
        document.getElementById('app-view').classList.remove('hidden-view');
        loadDashboard();
    }
});

function logout() {
    supabaseClient.auth.signOut();
    currentUser = null;
    document.getElementById('app-view').classList.add('hidden-view');
    document.getElementById('login-view').classList.remove('hidden-view');
}

// NAVIGATION
function switchView(viewName) {
    document.querySelectorAll('.app-view-section').forEach(el => el.classList.add('hidden-view'));
    document.getElementById(`view-${viewName}`).classList.remove('hidden-view');
    
    if (viewName === 'dashboard') loadDashboard();
    if (viewName === 'modal') loadModalData();
    if (viewName === 'pl') loadPLData();
    if (viewName === 'riwayat') loadRiwayatData();
    if (viewName === 'log') loadLogData();
    if (viewName === 'kuitansi') initKuitansiForm();
}

// DASHBOARD
async function loadDashboard() {
    const { data: receipts } = await supabaseClient.from('receipts').select('total_amount').eq('receipt_type', 'asli');
    const pemasukan = receipts?.reduce((sum, r) => sum + r.total_amount, 0) || 0;

    const { data: expenses } = await supabaseClient.from('expenses').select('jumlah');
    const pengeluaran = expenses?.reduce((sum, e) => sum + e.jumlah, 0) || 0;

    document.getElementById('dash-pemasukan').textContent = formatRupiah(pemasukan);
    document.getElementById('dash-pengeluaran').textContent = formatRupiah(pengeluaran);
    document.getElementById('dash-saldo').textContent = formatRupiah(pemasukan - pengeluaran);
}

// KUITANSI
function initKuitansiForm() {
    document.getElementById('k-tanggal').valueAsDate = new Date();
    document.getElementById('k-nomor').value = 'INV/' + Date.now();
    if (document.getElementById('items-container').children.length === 0) addItemRow();
}

function addItemRow() {
    const container = document.getElementById('items-container');
    const div = document.createElement('div');
    div.className = 'flex gap-2';
    div.innerHTML = `
        <input type="text" placeholder="Deskripsi" class="item-desc flex-1 border p-2 rounded" required>
        <input type="number" placeholder="Qty" class="item-qty w-20 border p-2 rounded" value="1" oninput="calcTotal()" required>
        <input type="number" placeholder="Harga" class="item-price w-32 border p-2 rounded" oninput="calcTotal()" required>
        <button type="button" onclick="this.parentElement.remove(); calcTotal()" class="text-red-500">🗑️</button>
    `;
    container.appendChild(div);
}

function calcTotal() {
    let total = 0;
    document.querySelectorAll('#items-container > div').forEach(row => {
        const qty = parseFloat(row.querySelector('.item-qty').value) || 0;
        const price = parseFloat(row.querySelector('.item-price').value) || 0;
        total += qty * price;
    });
    const diskon = parseFloat(document.getElementById('k-diskon').value) || 0;
    document.getElementById('k-total').textContent = formatRupiah(total - diskon);
    return total - diskon;
}

document.getElementById('kuitansi-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const total = calcTotal();
    
    const receiptData = {
        receipt_number: document.getElementById('k-nomor').value,
        receipt_type: 'asli',
        tanggal: document.getElementById('k-tanggal').value,
        pelanggan_nama: document.getElementById('k-pelanggan').value,
        pelanggan_alamat: document.getElementById('k-alamat').value,
        total_amount: total,
        created_by: currentUser.id
    };

    const { data: receipt, error } = await supabaseClient.from('receipts').insert(receiptData).select().single();
    
    if (error) {
        alert('Error: ' + error.message);
        return;
    }

    alert('Kuitansi tersimpan!');
    e.target.reset();
    initKuitansiForm();
});

// MODAL
document.getElementById('modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = {
        expense_type: document.getElementById('m-jenis').value,
        tanggal: document.getElementById('m-tanggal').value,
        nama_pengeluaran: document.getElementById('m-nama').value,
        jumlah: parseFloat(document.getElementById('m-jumlah').value),
        keterangan: document.getElementById('m-keterangan').value,
        created_by: currentUser.id
    };

    await supabaseClient.from('expenses').insert(data);
    alert('Modal tercatat!');
    e.target.reset();
    loadModalData();
});

async function loadModalData() {
    const { data } = await supabaseClient.from('expenses').select('*').order('tanggal', { ascending: false });
    document.getElementById('modal-list').innerHTML = data?.map(d => `
        <div class="p-3 border-b">
            <p class="font-bold">${d.nama_pengeluaran}</p>
            <p class="text-sm text-slate-500">${formatRupiah(d.jumlah)} - ${d.tanggal}</p>
        </div>
    `).join('') || 'Belum ada data';
}

// PL
async function loadPLData() {
    const { data: receipts } = await supabaseClient.from('receipts').select('total_amount');
    const { data: expenses } = await supabaseClient.from('expenses').select('jumlah');
    
    const pemasukan = receipts?.reduce((s, r) => s + r.total_amount, 0) || 0;
    const pengeluaran = expenses?.reduce((s, e) => s + e.jumlah, 0) || 0;
    
    document.getElementById('pl-pemasukan').textContent = formatRupiah(pemasukan);
    document.getElementById('pl-pengeluaran').textContent = formatRupiah(pengeluaran);
    document.getElementById('pl-laba').textContent = formatRupiah(pemasukan - pengeluaran);
}

// RIWAYAT
async function loadRiwayatData() {
    const { data } = await supabaseClient.from('receipts').select('*').order('tanggal', { ascending: false });
    document.getElementById('riwayat-list').innerHTML = data?.map(d => `
        <div class="p-3 border-b">
            <p class="font-bold">${d.receipt_number}</p>
            <p class="text-sm">${d.pelanggan_nama} - ${formatRupiah(d.total_amount)}</p>
        </div>
    `).join('') || 'Belum ada kuitansi';
}

// LOG
async function loadLogData() {
    const { data } = await supabaseClient.from('activity_logs').select('*').order('created_at', { ascending: false }).limit(20);
    document.getElementById('log-list').innerHTML = data?.map(d => `
        <div class="p-3 border-b text-sm">
            <p><b>${d.username}</b> - ${d.action}</p>
            <p class="text-slate-500">${new Date(d.created_at).toLocaleString('id-ID')}</p>
        </div>
    `).join('') || 'Belum ada log';
}
