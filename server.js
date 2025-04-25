require("dotenv").config();
const mysql = require("mysql2/promise");
const axios = require("axios");
const fs = require("fs");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const dbConfig = {
	host: process.env.DB_HOST,
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
};

let db;

// Bộ nhớ tạm theo dõi các ride: { notified, lastOverdueNotify }
const trackingRides = new Map();

const logToFile = (message) => {
	const timestamp = new Date().toISOString();
	fs.appendFileSync("server.log", `[${timestamp}] ${message}\n`);
};

async function connectToDatabase() {
	try {
		db = await mysql.createConnection(dbConfig);
		logToFile("✅ Đã kết nối MySQL");
	} catch (err) {
		logToFile("❌ Lỗi kết nối DB:", err.message);
		process.exit(1);
	}
}

async function checkNewRequestedRides() {
	try {
		const [rows] = await db.query(`
      SELECT id, pickup_address, dropoff_address, distance_km, final_fare, created_at
      FROM rides
      WHERE ride_status = 'requested' AND created_at >= NOW() - INTERVAL 10 SECOND
    `);

		for (const ride of rows) {
			if (trackingRides.has(ride.id)) continue;

			trackingRides.set(ride.id, {
				notified: false,
				lastOverdueNotify: null,
			});

			const formattedDistance = ride.distance_km
				? parseFloat(ride.distance_km).toString()
				: "0";

			const formattedFare = ride.final_fare
				? parseInt(ride.final_fare).toLocaleString("vi-VN")
				: "0";

			const message = `🆕 Chuyến đi mới được tạo:\n- ID: ${
				ride.id
			}\n- Đón: ${ride.pickup_address || "N/A"}\n- Đến: ${
				ride.dropoff_address || "N/A"
			}\n- Khoảng cách: ${formattedDistance}km\n- Giá: ${formattedFare} VNĐ`;

			await axios.post(
				`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
				{
					chat_id: TELEGRAM_CHAT_ID,
					text: message,
				}
			);

			logToFile("📤 Gửi Telegram (mới):", message);
		}
	} catch (err) {
		logToFile("❌ Lỗi khi kiểm tra ride mới:", err.message);
	}
}

async function checkStatusOfTrackingRides() {
	if (trackingRides.size === 0) return;

	const rideIds = Array.from(trackingRides.keys());
	try {
		const [rows] = await db.query(`
      SELECT id, ride_status, pickup_address, dropoff_address, updated_at, started_at, estimated_time, distance_km, final_fare
      FROM rides
      WHERE id IN (${rideIds.join(",")})
    `);

		const now = new Date();

		for (const ride of rows) {
			const track = trackingRides.get(ride.id);
			if (!track) continue;

			// Đã huỷ
			if (ride.ride_status === "canceled") {
				const message = `❌ Chuyến đi đã bị hủy:\n- ID: ${
					ride.id
				}\n- Đón: ${ride.pickup_address || "N/A"}\n- Đến: ${
					ride.dropoff_address || "N/A"
				}\n- Khoảng cách: ${formattedDistance}km\n- Giá: ${formattedFare} VNĐ`;

				await axios.post(
					`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
					{
						chat_id: TELEGRAM_CHAT_ID,
						text: message,
					}
				);

				logToFile("📤 Gửi Telegram (hủy):", message);
				trackingRides.delete(ride.id);
				continue;
			}

			// Đã hoàn thành
			if (ride.ride_status === "completed") {
				logToFile(`✅ Ride ${ride.id} đã hoàn thành`);
				trackingRides.delete(ride.id);
				continue;
			}

			// Quá hạn xử lý
			if (!ride.started_at || !ride.estimated_time) continue;

			const startedAt = new Date(ride.started_at);
			const overdueTime = new Date(
				startedAt.getTime() + (ride.estimated_time + 30) * 60000
			);
			const diffInMinutes = Math.floor((now - overdueTime) / 60000);

			if (diffInMinutes > 0) {
				if (!track.notified && diffInMinutes >= 30) {
					const message = `⚠️ Chuyến đi ID ${
						ride.id
					} đã quá hạn hơn ${diffInMinutes} phút!\n- Đón: ${
						ride.pickup_address || "N/A"
					}\n- Đến: ${ride.dropoff_address || "N/A"}`;

					await axios.post(
						`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
						{
							chat_id: TELEGRAM_CHAT_ID,
							text: message,
						}
					);

					logToFile("📤 Gửi Telegram (quá hạn lần đầu):", message);
					track.notified = true;
					track.lastOverdueNotify = now;
				}

				// Gửi nhắc lại mỗi 5 phút nếu quá 2 giờ
				if (diffInMinutes >= 120) {
					const last = track.lastOverdueNotify || new Date(0);
					if ((now - last) / 60000 >= 1) {
						const message = `⏰ Chuyến đi ID ${ride.id} quá hạn ${diffInMinutes} phút.\nHãy kiểm tra ngay!`;

						await axios.post(
							`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
							{
								chat_id: TELEGRAM_CHAT_ID,
								text: message,
							}
						);

						logToFile("📤 Gửi lại Telegram (quá 2 giờ):", message);
						track.lastOverdueNotify = now;
					}
				}
			}
		}
	} catch (err) {
		console.error("❌ Lỗi khi kiểm tra trạng thái ride:", err.message);
	}
}

async function start() {
	await connectToDatabase();
	logToFile("🚦 Đang theo dõi ride mới, huỷ, hoàn thành và quá hạn...");

	setInterval(() => {
		checkNewRequestedRides();
	}, 5000);

	setInterval(() => {
		checkStatusOfTrackingRides();
	}, 60000);
}

start();
