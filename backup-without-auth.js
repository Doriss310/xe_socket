const mysql = require("mysql2/promise");
const WebSocket = require("ws");
require("dotenv").config();
const fs = require("fs");

const admin = require("firebase-admin");
const serviceAccount = require("./firebase/serviceAccountKey.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const logToFile = (message) => {
    const timestamp = new Date().toISOString();
    fs.appendFileSync("server.log", `[${timestamp}] ${message}\n`);
};

const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
};

let db;
const clients = new Map();

const connectToDatabase = async () => {
    try {
        db = await mysql.createConnection(dbConfig);
    } catch (error) {
        logToFile(`Lỗi kết nối database: ${error.message}`);
        process.exit(1);
    }
};

const sendFCMNotification = async (deviceToken, title, body, data = {}) => {
    const message = {
        notification: {
            title,
            body,
        },
        data,
        token: deviceToken,
        apns: {
            payload: {
                aps: {
                    sound: 'default',
                    badge: 1,
                    contentAvailable: true,
                },
            },
            headers: {
                'apns-priority': '10',
            },
        },
        android: {
            priority: 'high',
            notification: {
                sound: 'default',
                clickAction: 'FLUTTER_NOTIFICATION_CLICK',
            },
        },
    };

    try {
        const response = await admin.messaging().send(message);
        logToFile(`✅ Sent FCM for ride_id ${data.ride_id} to ${deviceToken}: ${response}`);
        return {
            success: true,
            ride_id: data.ride_id,
            messageId: response
        };
    } catch (error) {
        logToFile(`❌ FCM Error for ride_id ${data.ride_id} - ${deviceToken}: ${error.message}`);

        if (
            error.code === 'messaging/invalid-registration-token' ||
            error.code === 'messaging/registration-token-not-registered'
        ) {
            try {
                await db.query(
                    `UPDATE drivers_users SET fcm_token = NULL WHERE fcm_token = ?`,
                    [deviceToken]
                );
                logToFile(`🗑️ Removed invalid FCM token: ${deviceToken}`);
            } catch (dbErr) {
                logToFile(`DB error when removing FCM token: ${dbErr.message}`);
            }
        }

        return {
            success: false,
            ride_id: data.ride_id,
            error: error.message
        };
    }
};

const getDriversWithRequestedRides = async () => {
    try {
        logToFile("Fetching drivers with requested rides...");

        // Lấy danh sách các chuyến đi đang ở trạng thái "requested"
        const [requestedRides] = await db.query(`
        SELECT DISTINCT drll.ride_id, drll.vehicle_type, drll.pickup_location 
        FROM driver_ride_location_logs drll
        WHERE drll.ride_status = 'requested'
    `);

        // Lấy danh sách tài xế đã có trong driver_ride_location_logs
        const [existingDrivers] = await db.query(`
      SELECT DISTINCT drll.ride_id, du.id AS driver_id, du.phone_number
      FROM drivers_users du
      JOIN driver_ride_location_logs drll ON du.id = drll.driver_id
      JOIN devices d ON du.device_id = d.id
      WHERE drll.ride_status = 'requested'
        AND d.name = drll.vehicle_type
        AND du.id NOT IN (
          SELECT driver_id
          FROM driver_ride_location_logs
          WHERE ride_status IN ('accepted', 'arrived_at_pickup', 'in_progress')
        )
    `);

        // Lấy danh sách tài xế active mà chưa có trong driver_ride_location_logs
        const [newDrivers] = await db.query(`
        SELECT DISTINCT ad.id AS driver_id, ad.phone_number, ad.device_id, ad.latitude, ad.longitude, ad.status, d.name AS vehicle_type
        FROM drivers_users ad
        JOIN devices d ON ad.device_id = d.id
        WHERE ad.status = 'active' AND ad.is_active = 1 AND ad.is_delete = 0
    `);

        // Lấy danh sách driver đang bận (ở bất kỳ ride nào)
        const [busyDrivers] = await db.query(`
      SELECT DISTINCT driver_id
      FROM driver_ride_location_logs
      WHERE ride_status IN ('accepted', 'arrived_at_pickup', 'in_progress')
    `);
        const busyDriverIds = new Set(busyDrivers.map(d => d.driver_id));

        let insertedDrivers = [];

        for (let ride of requestedRides) {
            // Truy vấn toàn bộ dữ liệu của chuyến đi để dùng cho INSERT
            const [rideDetails] = await db.query(
                `SELECT * FROM driver_ride_location_logs WHERE ride_id = ? LIMIT 1`,
                [ride.ride_id]
            );

            if (rideDetails.length === 0) continue; // Nếu không có dữ liệu thì bỏ qua

            const rideData = rideDetails[0]; // Dữ liệu gốc của chuyến đi

            for (let driver of newDrivers) {
                // Kiểm tra nếu driver chưa có trong danh sách tài xế đã nhận ride_id này
                const alreadyExists = existingDrivers.some(
                    (ex) => ex.ride_id === ride.ride_id && ex.driver_id === driver.driver_id
                );

                if (!alreadyExists && driver.vehicle_type === ride.vehicle_type) {
                    // Tính khoảng cách giữa tài xế và điểm đón khách
                    const pickupLat = parseFloat(ride.pickup_location.split(",")[0]);
                    const pickupLon = parseFloat(ride.pickup_location.split(",")[1]);
                    const driverLat = parseFloat(driver.latitude);
                    const driverLon = parseFloat(driver.longitude);

                    const distanceKm = await calculateDistance(pickupLat, pickupLon, driverLat, driverLon);
                    const isAround10Km = distanceKm <= 10 ? 1 : 0;

                    logToFile(`Adding new active driver ${driver.driver_id} to ride_id ${ride.ride_id}, distance: ${distanceKm.toFixed(2)} km`);

                    // Chèn vào bảng driver_ride_location_logs với đầy đủ thông tin từ rideData, nhưng cập nhật is_around_10km
                    await db.query(
                        `INSERT INTO driver_ride_location_logs 
            (ride_id, passenger_id, driver_id, is_around_10km, pickup_location, pickup_address, 
             dropoff_location, dropoff_address, route_geometry, ride_status, accepted_at, started_at, 
             completed_at, arrived_at_pickup_time, distance_km, estimated_fare, estimated_time, 
             discount_amount, final_fare, actual_fare, waiting_fee, peak_hour_fee, duration_minutes, 
             vehicle_type, voucher_id, rating, feedback, assigned_at, cancelable, driver_mobile_status, 
             user_mobile_status, vat_percent, vat, location_id, latitude, longitude, device_id, 
             created_at, updated_at, is_delete)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?)`,
                        [
                            rideData.ride_id,
                            rideData.passenger_id,
                            driver.driver_id,
                            isAround10Km,
                            rideData.pickup_location,
                            rideData.pickup_address,
                            rideData.dropoff_location,
                            rideData.dropoff_address,
                            rideData.route_geometry,
                            rideData.ride_status,
                            rideData.accepted_at,
                            rideData.started_at,
                            rideData.completed_at,
                            rideData.arrived_at_pickup_time,
                            rideData.distance_km,
                            rideData.estimated_fare,
                            rideData.estimated_time,
                            rideData.discount_amount,
                            rideData.final_fare,
                            rideData.actual_fare,
                            rideData.waiting_fee,
                            rideData.peak_hour_fee,
                            rideData.duration_minutes,
                            rideData.vehicle_type,
                            rideData.voucher_id,
                            rideData.rating,
                            rideData.feedback,
                            rideData.assigned_at,
                            rideData.cancelable,
                            rideData.driver_mobile_status,
                            rideData.user_mobile_status,
                            rideData.vat_percent,
                            rideData.vat,
                            rideData.location_id,
                            driver.latitude,
                            driver.longitude,
                            driver.device_id,
                            0
                        ]
                    );

                    insertedDrivers.push({
                        ride_id: ride.ride_id,
                        driver_id: driver.driver_id,
                        phone_number: driver.phone_number,
                        distance_km: distanceKm.toFixed(2),
                    });
                }
            }
        }

        const [fcmDrivers] = await db.query(`
      SELECT du.id AS driver_id, du.fcm_token, drll.ride_id, drll.pickup_address, drll.dropoff_address
      FROM driver_ride_location_logs drll
      JOIN drivers_users du ON du.id = drll.driver_id
      WHERE drll.ride_status = 'requested'
        AND drll.fcm_sent = 0
        AND drll.driver_id NOT IN (
          SELECT driver_id FROM driver_ride_location_logs
          WHERE ride_status IN ('accepted', 'arrived_at_pickup', 'in_progress')
        )
        AND drll.created_at >= NOW() - INTERVAL 5 MINUTE
    `);

        // Gửi FCM cho tất cả driver giống requestedDrivers (tức là chưa bận)
        const allDriversToNotify = existingDrivers.concat(insertedDrivers)
            .filter(driver => !busyDriverIds.has(driver.driver_id));

        for (const driver of fcmDrivers) {
            if (!driver.fcm_token) {
                logToFile(`⚠️ Driver ${driver.driver_id} không có FCM token`);
                continue;
            }

            const message = `Điểm đón: ${driver.pickup_address}\nĐiểm đến: ${driver.dropoff_address}`;
            const result = await sendFCMNotification(
                driver.fcm_token,
                "Yêu cầu chuyến đi mới",
                message,
                { ride_id: driver.ride_id.toString() }
            );

            if (result.success) {
                await db.query(
                    `UPDATE driver_ride_location_logs SET fcm_sent = 1 
           WHERE ride_id = ? AND driver_id = ?`,
                    [driver.ride_id, driver.driver_id]
                );
                logToFile(`✅ [ride_id ${result.ride_id}] FCM success: ${result.messageId}`);
            } else {
                logToFile(`❌ [ride_id ${result.ride_id}] FCM failed: ${result.error}`);
            }
        }

        const uniqueDriverPhoneNumbers = [
            ...new Set(
                existingDrivers
                    .concat(insertedDrivers)
                    .filter(driver => !busyDriverIds.has(driver.driver_id))
                    .map(driver => driver.phone_number)
            ),
        ];

        logToFile(`Unique drivers with requested rides (after insertion): ${JSON.stringify(uniqueDriverPhoneNumbers)}`);

        return uniqueDriverPhoneNumbers;
    } catch (error) {
        logToFile(`Error fetching drivers with requested rides: ${error.message}`);
        return [];
    }
};

// Hàm tính khoảng cách giữa hai tọa độ dựa trên công thức Haversine
const calculateDistance = async (lat1, lon1, lat2, lon2) => {
    const R = 6371; // Bán kính Trái Đất (km)
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) *
        Math.cos(lat2 * (Math.PI / 180)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

const server = require("http").createServer();
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
    const clientId = Date.now();
    console.log("Client connected");
    logToFile(`Client kết nối mới (ID: ${clientId})`);

    clients.set(ws, {
        id: clientId,
        isAlive: true,
        lastActivity: Date.now(),
    });

    // Gửi danh sách ngay khi kết nối
    getDriversWithRequestedRides().then((phoneNumbers) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ event: "requested_drivers", phoneNumbers }));
        }
    });

    ws.on("message", (message) => {
        try {
            const parsedMessage = JSON.parse(message);

            const client = clients.get(ws);
            if (client) {
                client.lastActivity = Date.now();
                client.isAlive = true;

                // Lưu driver_id khi nhận được init
                if (parsedMessage.type == "init" && parsedMessage.driver_id) {
                    client.driver_id = parsedMessage.driver_id;
                    logToFile(`Client ${client.id} đã khai báo driver_id: ${parsedMessage.driver_id}`);
                }
            }

            // Phản hồi ping
            if (parsedMessage.type === "ping") {
                ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
                logToFile(`Nhận được ping từ client ${client?.id}, đã gửi pong`);
            } else {
                console.log("Nhận được tin nhắn:", parsedMessage);
            }
        } catch (error) {
            console.error("Lỗi khi xử lý tin nhắn:", error);
            logToFile(`Lỗi khi xử lý tin nhắn: ${error.message}`);
        }
    });

    ws.on("close", () => {
        const client = clients.get(ws);
        const driverId = client?.driver_id || "unknown";

        console.log("Client disconnected");
        logToFile(`Client ngắt kết nối (Driver ID: ${driverId})`);
        clients.delete(ws);
    });

    ws.on("error", (error) => {
        console.error(`Lỗi trong kết nối client ${clientId}:`, error);
        logToFile(`Lỗi trong kết nối client ${clientId}: ${error.message}`);
        clients.delete(ws);
    });
});

// Sửa lại logic để chỉ gửi thông báo khi có chuyến đi mới
const monitorDriverStatus = async () => {
    console.log("Real-time driver status monitoring started...");
    logToFile("Real-time driver status monitoring started...");

    // Giữ danh sách các chuyến đi đã biết
    let knownRideIds = new Set();

    // Khởi tạo lần đầu
    try {
        const [initialRides] = await db.query(`
      SELECT DISTINCT ride_id FROM driver_ride_location_logs 
      WHERE ride_status = 'requested'
    `);
        initialRides.forEach(ride => knownRideIds.add(ride.ride_id));
        logToFile(`Initial known ride IDs: ${Array.from(knownRideIds).join(', ')}`);
    } catch (error) {
        logToFile(`Error initializing ride tracking: ${error.message}`);
    }

    setInterval(async () => {
        try {
            // Lấy danh sách chuyến đi hiện tại với trạng thái 'requested'
            const [currentRides] = await db.query(`
        SELECT DISTINCT ride_id FROM driver_ride_location_logs 
        WHERE ride_status = 'requested'
      `);

            const currentRideIds = new Set(currentRides.map(ride => ride.ride_id));
            const newRideIds = [];

            // Tìm những chuyến đi mới
            currentRides.forEach(ride => {
                if (!knownRideIds.has(ride.ride_id)) {
                    newRideIds.push(ride.ride_id);
                    knownRideIds.add(ride.ride_id);
                }
            });

            // Xóa các chuyến đi không còn trong trạng thái 'requested' nữa
            knownRideIds.forEach(rideId => {
                if (!currentRideIds.has(rideId)) {
                    knownRideIds.delete(rideId);
                }
            });

            // Nếu có chuyến đi mới, gửi thông báo
            if (newRideIds.length > 0) {
                logToFile(`New rides detected: ${newRideIds.join(', ')}`);

                const requestedDrivers = await getDriversWithRequestedRides();
                const newData = {
                    requestedDrivers,
                };

                console.log("New rides detected, sending update:", newData);
                logToFile(`Sending update due to new rides: ${JSON.stringify(newData)}`);

                wss.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(
                            JSON.stringify({ event: "driver_status_updated", data: newData })
                        );
                    }
                });
            }
        } catch (error) {
            logToFile(`Error monitoring ride status: ${error.message}`);
        }
    }, 5000);
};

const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        const client = clients.get(ws);

        if (!client) return;
        if (!client.isAlive) {
            logToFile(`Client ${client.id} không phản hồi, đóng kết nối`);
            clients.delete(ws);
            return ws.terminate();
        }

        client.isAlive = false;

        const inactiveTime = Date.now() - client.lastActivity;
        if (inactiveTime > 30000) {
            try {
                ws.send(
                    JSON.stringify({
                        type: "ping",
                        timestamp: Date.now(),
                    })
                );
                logToFile(`Gửi ping đến client ${client.id}`);
            } catch (error) {
                logToFile(`Lỗi khi gửi ping đến client ${client.id}: ${error.message}`);
                clients.delete(ws);
                ws.terminate();
            }
        }
    });
}, 30000);

server.on("close", () => {
    clearInterval(pingInterval);
    logToFile("Server đóng, đã dọn dẹp các interval");
});

const PORT = process.env.PORT || 3003;
server.listen(PORT, async () => {
    await connectToDatabase();
    console.log(`WebSocket Server is running on ws://localhost:${PORT}`);
    logToFile(`WebSocket Server is running on ws://localhost:${PORT}`);
    monitorDriverStatus();
});