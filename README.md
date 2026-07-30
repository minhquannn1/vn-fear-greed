# VN Fear & Greed Index

Chỉ số Sợ hãi & Tham lam cho thị trường chứng khoán Việt Nam — mô phỏng CNN Fear & Greed Index, bản địa hoá cho TTCK Việt Nam.

Điểm khác biệt so với các bản clone khác: trang này **nói thẳng nó có hiệu quả hay không**. Mỗi kết luận đi kèm một **phần trăm độ tin cậy** được suy ra từ dữ liệu — trong đó có một trần cứng đặt tự động dựa trên kết quả kiểm định lịch sử của chính quy tắc đó.

---

## Kiến trúc

```
index.html              Giao diện + style, không chứa logic tính toán
assets/engine.js        Toàn bộ phần tính toán. Thuần hàm, không DOM, không network.
assets/data.js          Tầng fetch: timeout, retry, giới hạn đồng thời, đếm lỗi
assets/ui.js            Tầng render. Mọi chuỗi động đi qua textContent
api/chart.js            Serverless proxy tới DNSE/Entrade (né CORS + cache CDN)
tools/build-snapshot.js Tính một lần ra dist/snapshot.js (chỉ cho bản offline + CI)
tools/build-standalone.js Gộp tất cả thành 1 file HTML chạy offline
tools/test-engine.js    112 unit test cho phần tính toán
tools/test-render.js    83 test render, dùng DOM shim tự viết (không cần jsdom)
fixtures/               Dữ liệu thật đã lưu, dùng cho test offline
```

Chạy thử:

```bash
npx serve .                      # hoặc: python3 -m http.server
node tools/test-engine.js        # chạy test
node tools/build-snapshot.js     # tính từ dữ liệu live, ghi ra dist/snapshot.js
node tools/build-snapshot.js --fixtures ./fixtures --dry-run   # chạy offline
```

Deploy: push lên Vercel. `api/chart.js` tự động thành serverless function; phần còn lại là static.

**Bắt buộc phải có Vercel (hoặc host chạy được serverless).** Entrade không gửi header CORS — đã kiểm tra thực tế từ một origin `github.io`, kết quả `Failed to fetch`. Nên host tĩnh thuần (GitHub Pages, S3) **không thể** dùng được: trình duyệt sẽ bị chặn khi gọi API trực tiếp. Nếu cần một file chạy offline, dùng `npm run standalone:full`.

## Không có dữ liệu dự phòng — có chủ đích

Trang luôn tính từ API, hoặc báo lỗi. Không nhúng snapshot nào vào trang.

Lý do: một con số cũ trông giống hệt một con số mới. Bản trước từng nhúng snapshot 100KB, và khi API lỗi thì người dùng vẫn thấy một kết luận trông rất tự tin — của phiên nào thì không rõ. Với một trang mà đầu ra là "nên mua hay nên chờ", đó là chế độ lỗi nguy hiểm nhất có thể có.

Thay vào đó: fetch lỗi → banner lỗi + nút thử lại, phần kết luận bị xoá trắng. `.github/workflows/health.yml` chạy pipeline thật mỗi ngày giao dịch và fail ầm ĩ nếu API chết, để bạn biết trước người dùng.

---

## 7 thành phần

| # | Thành phần | Tín hiệu thô | Chuẩn hoá |
|---|---|---|---|
| 1 | Đà thị trường | VN-Index / MA125 − 1 | `scoreDir` 252 phiên |
| 2 | Sức mạnh giá | (số mã VN30 sát đỉnh 52T − sát đáy 52T) / tổng | `scoreBounded` 156 tuần |
| 3 | Độ lan toả | EMA4 của (GTGD mã tăng − mã giảm)/(tổng) | `scoreBounded` 156 tuần |
| 4 | Tâm lý phái sinh | basis VN30F1M / VN30 − 1 | `scoreDir` 250 phiên |
| 5 | Biến động | RV20 / MA50(RV20) − 1 | `scoreDir` 252 phiên, đảo dấu |
| 6 | Nhu cầu trú ẩn | lợi suất 20 phiên − lãi suất phi rủi ro | `scoreDir` 252 phiên |
| 7 | Khẩu vị rủi ro | MA20(KLGD) / MA100(KLGD) − 1 | `scoreDir` 252 phiên |

Cả 7 dùng chung một họ chuẩn hoá: **50% phân vị trượt (chỉ dữ liệu quá khứ) + 50% tanh của khoảng cách tới mức trung tính, đo bằng độ lệch chuẩn quá khứ.** Nhờ vậy các thành phần mới thật sự cùng thang đo trước khi lấy trung bình.

---

## Chỉ số hoảng loạn

Một trục riêng, độc lập với F&G. F&G trả lời *"thị trường đang cảm thấy thế nào"*; chỉ số hoảng loạn trả lời *"đợt giảm này có mất kiểm soát không"*.

Sáu cấu phần: độ sâu chiết khấu từ đỉnh 250 phiên · khoảng cách dưới MA200 (chuẩn hoá theo biến động) · vỡ khối lượng khi giá giảm · mật độ phiên giảm trong 10 phiên · tốc độ giảm 10 phiên · phân vị biến động thực trong 2 năm.

Phân biệt quan trọng: **rẻ + bình tĩnh** thì gom từ từ; **rẻ + bán tháo có khối lượng** mới là vùng vào lệnh bất đối xứng. Giảm mạnh mà khối lượng CẠN thường là chưa xong.

---

## Độ tin cậy — cách tính

Không phải con số cảm tính. Bốn cấu phần cộng lại, rồi bị chặn bởi một trần:

| Cấu phần | Trọng số | Đo cái gì |
|---|---|---|
| Dữ liệu đầy đủ | 20% | Bao nhiêu trong 7 thành phần thực sự có dữ liệu |
| Thành phần đồng thuận | 25% | Độ phân tán giữa 7 điểm số. Mâu thuẫn nhau ⇒ điểm thấp |
| Bằng chứng lịch sử | 30% | Trung vị lợi suất tương lai có cùng dấu qua 1/3/6 tháng không, tỷ lệ thắng, và **số đợt thị trường riêng biệt** (không phải số phiên) |
| Độ cực trị | 25% | Chỉ số gần 50 thì ít thông tin |

**Trần tin cậy** đặt tự động từ backtest: nếu quy tắc thua danh mục cố định *cùng tỷ trọng trung bình*, trần bị hạ xuống 30–45%. Không có cách nào để trang này hiển thị "độ tin cậy cao" cho một quy tắc chưa chứng minh được giá trị.

Độ tin cậy còn quyết định **quy mô hành động**: 70%+ làm đủ quy mô, 50–70% làm 2/3, 30–50% chỉ thăm dò 1/3, dưới 30% thì đứng yên.

---

## Kết quả kiểm định — đọc kỹ phần này

Trên dữ liệu thật **2022-09-19 → 2026-07-24 (958 phiên, đủ 7/7 thành phần)**:

| Chiến lược | Tổng LN | CAGR | MaxDD | Tỷ trọng CP TB |
|---|---|---|---|---|
| Mua & giữ VN-Index | **+39,9%** | 9,2% | −25,2% | 100% |
| Cố định 58,7%, không định thời điểm | **+33,6%** | 7,9% | −15,2% | 58,7% |
| Quy tắc F&G (bản này) | **−1,7%** | −0,5% | −21,0% | 58,7% |

**Ở cùng mức tỷ trọng cổ phiếu trung bình, việc định thời điểm theo F&G làm mất khoảng 35 điểm phần trăm.** Kiểm tra thêm bằng DCA (giải ngân đều hàng tháng): nghiêng về mua khi sợ hãi hơn phương án luôn giải ngân đủ đúng **+0,13%** — trong khi nghiêng theo chiều **ngược lại** cũng hơn +0,08%. Cả hai đều là nhiễu.

Vì sao vẫn công bố? Vì đây là con số thật sau khi loại bỏ lỗi nhìn trước (look-ahead) mà phiên bản trước mắc phải. Một backtest đẹp nhờ rò rỉ dữ liệu tương lai còn nguy hiểm hơn một backtest xấu nhưng trung thực.

**Trên mẫu dài hơn thì còn tệ hơn.** Bản live fetch sâu hơn fixtures — **1.139 phiên từ 2021-12-27**, tức bao gồm cả thị trường giảm 2022:

| | Chiến lược | Mua & giữ | Cố định 60% |
|---|---|---|---|
| Tổng | **−15,8%** | +14,5% | +20,9% |
| Nửa đầu mẫu | −21,7% | −15,5% | — |
| Nửa sau mẫu | +6,6% | +33,5% | — |

Điều này xoá bỏ lời biện hộ "chỉ tại mẫu toàn thị trường tăng": nửa đầu mẫu là thị trường **giảm** (mua & giữ −15,5%) mà quy tắc vẫn lỗ nặng hơn (−21,7%). Nó thua ở cả hai chế độ thị trường, ở cả hai nửa mẫu.

Tỷ lệ cơ sở cũng xác nhận: vùng `< 20` có **n=34, trung vị −1,9%, chỉ 47% phiên dương** — vùng sợ hãi nhất lại là vùng *tệ nhất*, còn `> 70` (tham lam cực độ) cho +3,1% / 69%. Không có lợi thế contrarian đơn điệu nào trong dữ liệu Việt Nam từ 2021.

Mẫu vẫn ngắn (chưa có 2018, 2008) nên chưa thể kết luận tuyệt đối. Nhưng gánh nặng chứng minh thuộc về quy tắc, và nó chưa chứng minh được gì.

**Nên dùng chỉ số này để làm gì:** như một cái phanh cảm xúc — biết thị trường đang ở đâu trong phổ tâm lý, và không bán tháo cùng đám đông. Không nên dùng như một cỗ máy định thời điểm.

---

## Những lỗi đã sửa so với phiên bản trước

**Lỗi phương pháp**

1. **Nhìn trước trong chuẩn hoá** — `rollPct` cũ tính phân vị của điểm hiện tại trong cửa sổ *bao gồm chính nó* (`v <= cur`), nên không bao giờ trả về 0 và làm backtest đẹp giả tạo. Nay dùng cửa sổ **thuần quá khứ**, có unit test chứng minh chuỗi điểm bất biến khi cắt ngắn dữ liệu.
2. **Hai thành phần khác thang đo** — `strength` và `breadth` cũ chỉ dùng tanh trần, không phân vị, rồi vẫn đem trung bình chung với 5 thành phần kia. Nay dùng cùng họ chuẩn hoá.
3. **Chia lại trọng số âm thầm** — điều kiện `if (vals.length >= 6)` khiến một thành phần biến mất là 6 thành phần còn lại tự động gánh 1/6 mỗi cái, không có cảnh báo nào. Nay `coverage` và danh sách thành phần thiếu được trả về và hiển thị.
4. **Ba mươi lệnh fetch nuốt lỗi** — `.catch(() => null)` cho từng mã. Hỏng 20/30 mã vẫn ra một con số trông rất tự tin. Nay đếm và hiển thị số mã tải được.
5. **EWM sai** — hàm cũ vẫn suy giảm bộ tích luỹ khi gặp NaN, trái với chính comment của nó. Nay khớp `pandas.ewm(adjust=True, ignore_na=True)`, có test đối chiếu giá trị.
6. **Tuần dữ liệu quá ngắn** — cửa sổ cũ ~71 bar tuần trong khi cần 52 bar cho đỉnh/đáy 52 tuần. Nay kéo dài lên ~278 bar.
7. **Forward-fill vô hạn** — nếu feed tuần đứng, `strength`/`breadth` cũ giữ nguyên giá trị cũ mãi mãi. Nay quá 21 ngày thì thành phần rụng ra và báo thiếu dữ liệu.

**Lỗi hiển thị**

8. **`previous.year` không tồn tại ở chế độ live** — luôn hiện `—`.
9. **Thiếu dữ liệu bị ép thành 0** — `+(x || 0).toFixed(1)` biến giá trị thiếu thành **0,0 = Sợ hãi cực độ**, còn nhãn thì lại lấy `|| 50` = Trung tính. Nay thiếu là `null`, hiển thị `—`.
10. **Không có timeout/retry** — 33 request song song không giới hạn. Nay có timeout 15s, retry luỹ thừa, tối đa 6 request đồng thời.
11. **Không cảnh báo dữ liệu cũ** — nay có badge `DỮ LIỆU CŨ` khi dữ liệu quá 5 ngày.
12. **`innerHTML` với dữ liệu ngoài** — nay toàn bộ dùng `textContent`.

**Lỗi hạ tầng**

13. **`vercel.json` rewrite chết** — `/chart-api/:path*` không bao giờ được gọi. Đã thay bằng cấu hình header thật.
14. **Proxy mở** — regex `^[A-Z0-9]+$` cho phép relay ký hiệu bất kỳ. Nay dùng allowlist, có timeout và retry.
15. **`compute.py` không tồn tại** — mọi comment đều ghi "mirror compute.py" nhưng file không có trong repo, nên snapshot không thể sinh lại và hai bản cài đặt có thể trôi khỏi nhau lúc nào không biết. Nay `tools/build-snapshot.js` dùng **chính `engine.js`** — không thể lệch nhau về mặt cấu trúc.
16. **Snapshot 100KB một dòng** — mọi diff git đều vô dụng. Nay **bỏ hẳn snapshot khỏi trang**: luôn tính trực tiếp, lỗi thì báo lỗi. Xem mục "Không có dữ liệu dự phòng" ở trên.
17. **Canvas phình vô hạn** — `<canvas height="210">` kèm `maintainAspectRatio:false` khiến Chart.js đo chính phần tử nó đang resize: mỗi lần vẽ lại canvas cao thêm, tới ~3.300px thì Chrome bỏ không render. Biểu đồ trắng trơn và **trang cuộn xuống vô tận**, không có lỗi nào trong console. Nay chiều cao nằm ở `div.chartbox`, canvas không mang thuộc tính height, sparkline dùng bitmap cố định + `responsive:false`. Có test chặn hồi quy.

---

## Hạn chế còn lại

- Dữ liệu chỉ có từ khoảng 2020 (API công khai), chưa bao gồm chu kỳ 2018 hay 2008.
- Tỷ lệ cơ sở dùng cửa sổ chồng lấn. Trang hiển thị **số đợt riêng biệt** bên cạnh số phiên, vì số phiên gây hiểu nhầm về cỡ mẫu.
- Danh sách VN30 hardcode, không tự động cập nhật khi HOSE cơ cấu lại rổ.
- Vòng quay danh mục ~9 lần/năm là quá cao — tín hiệu thô chưa có vùng đệm (hysteresis). Đây là hướng cải thiện rõ ràng nhất tiếp theo.
- Bộ quy tắc verdict được thiết kế sau khi đã quan sát lịch sử. Đây là in-sample và trang có nói rõ điều đó.

---

## Miễn trừ trách nhiệm

Công cụ phân tích định lượng phục vụ mục đích tham khảo và giáo dục. **Không phải khuyến nghị đầu tư cá nhân.** Hiệu suất quá khứ không đảm bảo kết quả tương lai. Dữ liệu từ API công khai, có thể sai sót hoặc gián đoạn. Người dùng tự chịu trách nhiệm cho quyết định giao dịch của mình.

Nguồn dữ liệu: DNSE / Entrade public chart API.
