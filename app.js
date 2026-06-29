// ==========================================
// KONFIGURASI SUPABASE (GANTI DENGAN MILIK ANDA)
// ==========================================
const SUPABASE_URL = 'https://grguwialhmpvssqksgdp.supabase.co'; // Ganti ini
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdyZ3V3aWFsaG1wdnNzcWtzZ2RwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2OTcwNzIsImV4cCI6MjA5ODI3MzA3Mn0.NJaM9KzjnuOzKFpl93fzUoJ9ZIYkzP0qVXXKuZFbgc8'; // Ganti ini

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// ==========================================
// STATE & UTILS
// ==========================================
let currentUser = null;
let plChartInstance = null;

const formatRupiah = (num) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(num || 0);
const formatDate = (dateStr) => new Date(dateStr).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });

// ==========================================
// AUTHENTICATION
// ==========================================
document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    const email = `${username}@percetakan.com`; // Trik login username

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    
    if (error) {
        const errDiv = document.getElementById('login-error');
        errDiv.textContent = 'Password salah atau akun tidak ditemukan.';
        errDiv.classList.remove('hidden');
    } else {
        currentUser = { username, id: data.user.id };
        document.getElementById('login-view').classList.add('hidden-view');
        document.getElementById('app-view').classList.remove('hidden-view');
        document.getElementById('user-name').textContent = username.charAt(0).toUpperCase() + username.slice(1);
        document.getElementById('user-avatar').textContent = username.charAt(0).toUpperCase();
        
        logActivity('login', 'User login ke sistem');
        switchView('dashboard');
        loadDashboard();
    }
});

async function logout() {
    await supabase.auth.signOut();
    logActivity('logout', 'User logout');
    currentUser = null;
    document.getElementById('app-view').classList.add('hidden-view');
    document.getElementById('login-view').classList.remove('hidden-view');
    document.getElementById('login-password').value = '';
}

// ==========================================
// NAVIGATION
// ==========================================
function switchView(viewName) {
    document.querySelectorAll('.app-view-section').forEach(el => el.classList.add('hidden-view'));
    document.getElementById(`view-${viewName}`).classList.remove('hidden-view');
    
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('bg-indigo-800');
        if(btn.dataset.target === viewName) btn.classList.add('bg-indigo-800');
    });

    // Load data spesifik view
    if (viewName === 'kuitansi') initKuitansiForm();
    if (viewName === 'modal') loadModalData();
    if (viewName === 'pl') loadPLData();
    if (viewName === 'riwayat') loadRiwayatData();
    if (viewName === 'log') loadLogData();
}

// ==========================================
// DASHBOARD
// ==========================================
async function loadDashboard() {
    // Fetch Pemasukan (Kuitansi Asli)
    const { data: receipts } = await supabase.from('receipts').select('total_amount').eq('receipt_type', 'asli');
    const pemasukan = receipts?.reduce((sum, r) => sum + r.total_amount, 0) || 0;

    // Fetch Pengeluaran (Modal + Lain)
    const { data: expenses } = await supabase.from('expenses').select('jumlah');
    const { data: otherExp } = await supabase.from('other_transactions').select('jumlah').eq('transaction_type', 'pengeluaran_lain');
    
    const totalPengeluaran = (expenses?.reduce((sum, e) => sum + e.jumlah, 0) || 0) + (otherExp?.reduce((sum, e) => sum + e.jumlah, 0) || 0);
    const saldo = pemasukan - totalPengeluaran;

    // Order Bulan Ini
    const currentMonth = new Date().toISOString().slice(0, 7);
    const { count } = await supabase.from('receipts').select('*', { count: 'exact', head: true }).gte('tanggal', `${currentMonth}-01`);

    document.getElementById('dash-pemasukan').textContent = formatRupiah(pemasukan);
    document.getElementById('dash-pengeluaran').textContent = formatRupiah(totalPengeluaran);
    document.getElementById('dash-saldo').textContent = formatRupiah(saldo);
    document.getElementById('dash-orders').textContent = count || 0;

    document.getElementById('dash-recent-transactions').innerHTML = '<p class="text-green-600">Data berhasil dimuat dari Supabase!</p>';
}

// ==========================================
// KUITANSI
// ==========================================
function initKuitansiForm() {
    document.getElementById('k-tanggal').valueAsDate = new Date();
    document.getElementById('k-nomor').value = 'INV/' + new Date().toISOString().slice(0,10).replace(/-/g,'') + '/001'; // Simple auto number
    if (document.getElementById('items-container').children.length === 0) addItemRow();
}

function addItemRow() {
    const container = document.getElementById('items-container');
    const div = document.createElement('div');
    div.className = 'flex gap-2 items-center';
    div.innerHTML = `
        <input type="text" placeholder="Deskripsi" class="item-desc flex-1 px-3 py-2 border rounded-lg" required>
        <input type="number" placeholder="Qty" class="item-qty w-20 px-3 py-2 border rounded-lg" value="1" min="1" oninput="calcTotal()" required>
        <input type="number" placeholder="Harga" class="item-price w-32 px-3 py-2 border rounded-lg" oninput="calcTotal()" required>
        <button type="button" onclick="this.parentElement.remove(); calcTotal()" class="text-red-500 hover:text-red-700"><i class="fas fa-trash"></i></button>
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
    const finalTotal = total - diskon;
    document.getElementById('k-total').textContent = formatRupiah(finalTotal);
    return finalTotal;
}

document.getElementById('kuitansi-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const total = calcTotal();
    const type = document.querySelector('input[name="receipt-type"]:checked').value;
    
    const receiptData = {
        receipt_number: document.getElementById('k-nomor').value,
        receipt_type: type,
        tanggal: document.getElementById('k-tanggal').value,
        pelanggan_nama: document.getElementById('k-pelanggan').value,
        pelanggan_alamat: document.getElementById('k-alamat').value,
        dp_amount: parseFloat(document.getElementById('k-dp').value) || 0,
        diskon_amount: parseFloat(document.getElementById('k-diskon').value) || 0,
        total_amount: total,
        catatan: document.getElementById('k-catatan').value,
        created_by: currentUser.id,
        status: total > 0 ? 'LUNAS' : 'BELUM LUNAS'
    };

    const { data: receipt, error } = await supabase.from('receipts').insert(receiptData).select().single();
    
    if (error) {
        alert('Gagal menyimpan: ' + error.message);
        return;
    }

    // Insert Items
    const items = [];
    document.querySelectorAll('#items-container > div').forEach((row, index) => {
        items.push({
            receipt_id: receipt.id,
            nomor_urut: index + 1,
            deskripsi: row.querySelector('.item-desc').value,
            qty: parseFloat(row.querySelector('.item-qty').value),
            harga_satuan: parseFloat(row.querySelector('.item-price').value)
        });
    });
    if (items.length > 0) await supabase.from('receipt_items').insert(items);

    logActivity('kuitansi', `Membuat kuitansi ${receipt.receipt_number}`);
    alert('Kuitansi berhasil disimpan!');
    e.target.reset();
    initKuitansiForm();
});

// ==========================================
// MODAL & PENGELUARAN
// ==========================================
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

    await supabase.from('expenses').insert(data);
    logActivity('modal', `Catat pengeluaran: ${data.nama_pengeluaran}`);
    alert('Pengeluaran modal tercatat!');
    e.target.reset();
    loadModalData();
});

async function loadModalData() {
    const { data } = await supabase.from('expenses').select('*').order('tanggal', { ascending: false });
    if (!data) return;

    let fisik = 0, ops = 0;
    data.forEach(d => {
        if (d.expense_type === 'modal_fisik') fisik += d.jumlah;
        else ops += d.jumlah;
    });

    document.getElementById('modal-fisik-total').textContent = formatRupiah(fisik);
    document.getElementById('modal-ops-total').textContent = formatRupiah(ops);
    document.getElementById('modal-total-all').textContent = formatRupiah(fisik + ops);

    document.getElementById('modal-list').innerHTML = data.map(d => `
        <div class="flex justify-between p-3 border-b">
            <div>
                <p class="font-medium">${d.nama_pengeluaran}</p>
                <p class="text-sm text-slate-500">${formatDate(d.tanggal)} - ${d.keterangan || '-'}</p>
            </div>
            <span class="font-bold text-red-600">${formatRupiah(d.jumlah)}</span>
        </div>
    `).join('');
}

// ==========================================
// UNTUNG RUGI
// ==========================================
document.getElementById('other-trans-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = {
        transaction_type: document.getElementById('ot-jenis').value,
        tanggal: new Date().toISOString().slice(0,10),
        jenis: document.getElementById('ot-nama').value,
        jumlah: parseFloat(document.getElementById('ot-jumlah').value),
        created_by: currentUser.id
    };
    await supabase.from('other_transactions').insert(data);
    logActivity('pl', `Catat transaksi lain: ${data.jenis}`);
    e.target.reset();
    loadPLData();
});

async function loadPLData() {
    // Simplified PL logic
    const { data: receipts } = await supabase.from('receipts').select('total_amount').eq('receipt_type', 'asli');
    const { data: expenses } = await supabase.from('expenses').select('jumlah, expense_type');
    const { data: others } = await supabase.from('other_transactions').select('jumlah, transaction_type');

    const pemasukanAsli = receipts?.reduce((s, r) => s + r.total_amount, 0) || 0;
    const pemasukanLain = others?.filter(o => o.transaction_type === 'pemasukan_lain').reduce((s, o) => s + o.jumlah, 0) || 0;
    
    const modalFisik = expenses?.filter(e => e.expense_type === 'modal_fisik').reduce((s, e) => s + e.jumlah, 0) || 0;
    const modalOps = expenses?.filter(e => e.expense_type === 'modal_operasional').reduce((s, e) => s + e.jumlah, 0) || 0;
    const pengeluaranLain = others?.filter(o => o.transaction_type === 'pengeluaran_lain').reduce((s, o) => s + o.jumlah, 0) || 0;

    const subIn = pemasukanAsli + pemasukanLain;
    const subOut = modalFisik + modalOps + pengeluaranLain;

    document.getElementById('pl-pemasukan-asli').textContent = formatRupiah(pemasukanAsli);
    document.getElementById('pl-pemasukan-lain').textContent = formatRupiah(pemasukanLain);
    document.getElementById('pl-sub-pemasukan').textContent = formatRupiah(subIn);
    document.getElementById('pl-modal-fisik').textContent = formatRupiah(modalFisik);
    document.getElementById('pl-modal-ops').textContent = formatRupiah(modalOps);
    document.getElementById('pl-pengeluaran-lain').textContent = formatRupiah(pengeluaranLain);
    document.getElementById('pl-sub-pengeluaran').textContent = formatRupiah(subOut);
    document.getElementById('pl-laba-bersih').textContent = formatRupiah(subIn - subOut);

    // Render Chart
    renderPLChart();
}

function renderPLChart() {
    const ctx = document.getElementById('pl-chart').getContext('2d');
    if (plChartInstance) plChartInstance.destroy();
    
    // Dummy data for chart (bisa diganti dengan query group by month)
    plChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun'],
            datasets: [{
                label: 'Pemasukan',
                data: [12, 19, 3, 5, 2, 3],
                borderColor: 'rgb(34, 197, 94)',
                tension: 0.1
            }, {
                label: 'Pengeluaran',
                data: [2, 3, 20, 5, 1, 4],
                borderColor: 'rgb(239, 68, 68)',
                tension: 0.1
            }]
        }
    });
}

// ==========================================
// LOG AKTIVITAS
// ==========================================
async function logActivity(action, details) {
    await supabase.from('activity_logs').insert({
        user_id: currentUser?.id,
        username: currentUser?.username,
        action,
        details: { message: details }
    });
}

async function loadLogData() {
    const { data } = await supabase.from('activity_logs').select('*').order('created_at', { ascending: false }).limit(50);
    document.getElementById('log-list').innerHTML = data?.map(l => `
        <div class="flex justify-between p-3 border-b text-sm">
            <div>
                <span class="font-bold text-indigo-600">[${l.username}]</span> 
                <span class="font-medium">${l.action}</span>
                <p class="text-slate-500">${l.details?.message || '-'}</p>
            </div>
            <span class="text-slate-400">${new Date(l.created_at).toLocaleString('id-ID')}</span>
        </div>
    `).join('') || 'Belum ada log.';
}

// ==========================================
// BACKUP & RESTORE (Simplified)
// ==========================================
async function backupData(type) {
    let dataToBackup = {};
    if (type === 'all' || type === 'kuitansi') {
        const { data: receipts } = await supabase.from('receipts').select('*, receipt_items(*)');
        dataToBackup.receipts = receipts;
    }
    
    const blob = new Blob([JSON.stringify(dataToBackup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backup_${type}_${Date.now()}.json`;
    a.click();
}

// Helper untuk print (bisa dikembangkan dengan window.print)
function printReceipt() {
    alert('Fitur cetak akan membuka dialog print browser. Pastikan preview sudah benar.');
    window.print();
}