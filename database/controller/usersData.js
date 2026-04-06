const { existsSync, writeJsonSync, readJSONSync } = require("fs-extra");
const moment = require("moment-timezone");
const path = require("path");
const axios = require("axios");
const _ = require("lodash");
const { CustomError, TaskQueue, getType } = global.utils;

const optionsWriteJSON = {
    spaces: 2,
    EOL: "\n"
};
const taskQueue = new TaskQueue(function (task, callback) {
    if (getType(task) === "AsyncFunction") {
        task()
            .then(result => callback(null, result))
            .catch(err => callback(err));
    }
    else {
        try {
            const result = task();
            callback(null, result);
        }
        catch (err) {
            callback(err);
        }
    }
});
if (!global.client?.database?.creatingUserData) {
    if (!global.client) global.client = {};
    if (!global.client.database) global.client.database = {};
    global.client.database.creatingUserData = [];
}
const { creatingUserData } = global.client.database;
module.exports = async function (databaseType, userModel, api, fakeGraphql) {
    let Users = [];
    const pathUsersData = path.join(__dirname, "..", "data/usersData.json");
    if (databaseType === "json") {
        const dataDir = path.join(__dirname, "..", "data");
        if (!existsSync(dataDir)) {
            const fs = require("fs");
            fs.mkdirSync(dataDir, { recursive: true });
        }
    }
    switch (databaseType) {
        case "mongodb": {
            if (!userModel) break;
            Users = (await userModel.find({}).lean()).map(user => _.omit(user, ["_id", "__v"]));
            break;
        }
        case "sqlite": {
            if (!userModel) break;
            Users = (await userModel.findAll()).map(user => user.get({ plain: true }));
            break;
        }
        case "json": {
            if (!existsSync(pathUsersData))
                writeJsonSync(pathUsersData, [], optionsWriteJSON);
            Users = readJSONSync(pathUsersData);
            break;
        }
    }
    global.db = global.db || {};
    global.db.allUserData = Users || [];
    async function save(userID, userData, mode, path) {
        try {
            let index = _.findIndex(global.db.allUserData, { userID });

            if (index === -1 && mode === "update") {
                try {
                    await create_(userID);
                    index = _.findIndex(global.db.allUserData, { userID });
                    if (index === -1) {
                        throw new CustomError({
                            name: "USER_NOT_FOUND",
                            message: `Can't find user with userID: ${userID} in database`
                        });
                    }
                }
                catch (err) {
                    throw new CustomError({
                        name: "USER_NOT_FOUND",
                        message: `Can't find user with userID: ${userID} in database`
                    });
                }
            }
            switch (mode) {
                case "create": {
                    switch (databaseType) {
                        case "mongodb":
                        case "sqlite": {
                            if (!userModel) throw new Error("User model not available");
                            let dataCreated = await userModel.create(userData);
                            dataCreated = databaseType === "mongodb" ?
                                _.omit(dataCreated._doc, ["_id", "__v"]) :
                                dataCreated.get({ plain: true });
                            global.db.allUserData.push(dataCreated);
                            return _.cloneDeep(dataCreated);
                        }
                        case "json": {
                            const timeCreate = moment.tz().format();
                            userData.createdAt = timeCreate;
                            userData.updatedAt = timeCreate;
                            global.db.allUserData.push(userData);
                            writeJsonSync(pathUsersData, global.db.allUserData, optionsWriteJSON);
                            return _.cloneDeep(userData);
                        }
                        default: {
                            break;
                        }
                    }
                    break;
                }
                case "update": {
                    const oldUserData = global.db.allUserData[index];
                    const dataWillChange = {};

                    if (Array.isArray(path) && Array.isArray(userData)) {
                        path.forEach((p, idx) => {
                            const key = p.split(".")[0];
                            dataWillChange[key] = oldUserData[key];
                            _.set(dataWillChange, p, userData[idx]);
                        });
                    }
                    else if (path && (typeof path === "string" || Array.isArray(path))) {
                        const key = Array.isArray(path) ? path[0] : path.split(".")[0];
                        dataWillChange[key] = oldUserData[key];
                        _.set(dataWillChange, path, userData);
                    }
                    else if (typeof userData === "object" && !Array.isArray(userData)) {
                        for (const key in userData) {
                            if (Object.prototype.hasOwnProperty.call(userData, key)) {
                                dataWillChange[key] = userData[key];
                            }
                        }
                    } else {
                        if (typeof path === "string") {
                            _.set(dataWillChange, path, userData);
                        }
                    }
                    switch (databaseType) {
                        case "mongodb": {
                            if (!userModel) throw new Error("User model not available");
                            let dataUpdated = await userModel.findOneAndUpdate(
                                { userID }, 
                                dataWillChange, 
                                { returnDocument: 'after' }
                            );
                            if (!dataUpdated) throw new Error(`User ${userID} not found`);
                            dataUpdated = _.omit(dataUpdated._doc, ["_id", "__v"]);
                            global.db.allUserData[index] = dataUpdated;
                            return _.cloneDeep(dataUpdated);
                        }
                        case "sqlite": {
                            if (!userModel) throw new Error("User model not available");
                            const user = await userModel.findOne({ where: { userID } });
                            if (!user) throw new Error(`User ${userID} not found`);
                            const dataUpdated = (await user.update(dataWillChange)).get({ plain: true });
                            global.db.allUserData[index] = dataUpdated;
                            return _.cloneDeep(dataUpdated);
                        }
                        case "json": {
                            dataWillChange.updatedAt = moment.tz().format();
                            global.db.allUserData[index] = {
                                ...oldUserData,
                                ...dataWillChange
                            };
                            writeJsonSync(pathUsersData, global.db.allUserData, optionsWriteJSON);
                            return _.cloneDeep(global.db.allUserData[index]);
                        }
                        default: {
                            break;
                        }
                    }
                    break;
                }
                case "remove": {
                    if (index !== -1) {
                        global.db.allUserData.splice(index, 1);
                        switch (databaseType) {
                            case "mongodb":
                                if (userModel) await userModel.deleteOne({ userID });
                                break;
                            case "sqlite":
                                if (userModel) await userModel.destroy({ where: { userID } });
                                break;
                            case "json":
                                writeJsonSync(pathUsersData, global.db.allUserData, optionsWriteJSON);
                                break;
                        }
                    }
                    break;
                }
                default: {
                    break;
                }
            }
            return null;
        }
        catch (err) {
            throw err;
        }
    }
    function getNameInDB(userID) {
        const userData = global.db.allUserData.find(u => u.userID == userID);
        return userData ? userData.name : null;
    }
    async function getName(userID, checkData = true) {
        if (isNaN(userID)) {
            throw new CustomError({
                name: "INVALID_USER_ID",
                message: `The first argument (userID) must be a number, not ${typeof userID}`
            });
        }
        if (checkData) {
            const name = getNameInDB(userID);
            if (name) return name;
        }
        try {
            const user = await axios.post(`https://www.facebook.com/api/graphql/?q=${`node(${userID}){name}`}`);
            return user.data[userID]?.name || getNameInDB(userID) || "Unknown";
        }
        catch (error) {
            return getNameInDB(userID) || "Unknown";
        }
    }
    async function getAvatarUrl(userID) {
        if (isNaN(userID)) {
            throw new CustomError({
                name: "INVALID_USER_ID",
                message: `The first argument (userID) must be a number, not ${typeof userID}`
            });
        }
        const FB_ACCESS_TOKEN = "6628568379%7Cc1e620fa708a1d5696fb991c1bde5662";
        try {
            const user = await axios.post(`https://www.facebook.com/api/graphql/`, null, {
                params: {
                    doc_id: "5341536295888250",
                    variables: JSON.stringify({ height: 500, scale: 1, userID, width: 500 })
                }
            });
            return user.data?.data?.profile?.profile_picture?.uri || `https://graph.facebook.com/${userID}/picture?height=500&width=500&access_token=${FB_ACCESS_TOKEN}`;
        }
        catch (err) {
            return `https://graph.facebook.com/${userID}/picture?height=500&width=500&access_token=${FB_ACCESS_TOKEN}`;
        }
    }
    function xGender(gender) {
        if (!gender) return 0;
        const g = String(gender).toLowerCase();
        if (g === "female" || g === "f") return 1;
        if (g === "male" || g === "m") return 2;
        return 0;
    }
    async function create_(userID, userInfo) {
        const findInCreatingData = creatingUserData?.find(u => u.userID == userID);
        if (findInCreatingData)
            return findInCreatingData.promise;
        const queue = new Promise(async function (resolve_, reject_) {
            try {
                if (global.db.allUserData.some(u => u.userID == userID)) {
                    throw new CustomError({
                        name: "DATA_ALREADY_EXISTS",
                        message: `User with id "${userID}" already exists in the data`
                    });
                }
                if (isNaN(userID)) {
                    throw new CustomError({
                        name: "INVALID_USER_ID",
                        message: `The first argument (userID) must be a number, not ${typeof userID}`
                    });
                }
                let userInfoData = userInfo;
                if (!userInfoData && api && typeof api.getUserInfo === 'function') {
                    try {
                        userInfoData = (await api.getUserInfo(userID))[userID];
                    } catch(e) {
                        userInfoData = null;
                    }
                }
                let userData = {
                    userID,
                    name: userInfoData?.name || "Unknown",
                    gender: xGender(userInfoData?.gender),
                    vanity: userInfoData?.vanity || null,
                    exp: 0,
                    money: 0,
                    banned: {},
                    settings: {},
                    data: {},
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };
                userData = await save(userID, userData, "create");
                resolve_(_.cloneDeep(userData));
            }
            catch (err) {
                reject_(err);
            }
            finally {
                const idx = creatingUserData?.findIndex(u => u.userID == userID);
                if (idx !== undefined && idx !== -1) {
                    creatingUserData.splice(idx, 1);
                }
            }
        });
        if (creatingUserData) {
            creatingUserData.push({
                userID,
                promise: queue
            });
        }
        return queue;
    }
    async function create(userID, userInfo) {
        return new Promise(function (resolve, reject) {
            taskQueue.push(function () {
                create_(userID, userInfo)
                    .then(resolve)
                    .catch(reject);
            });
        });
    }
    async function refreshInfo(userID, updateInfoUser) {
        return new Promise(async function (resolve, reject) {
            taskQueue.push(async function () {
                try {
                    if (isNaN(userID)) {
                        throw new CustomError({
                            name: "INVALID_USER_ID",
                            message: `The first argument (userID) must be a number, not ${typeof userID}`
                        });
                    }
                    const infoUser = await get_(userID);
                    let updateInfo = updateInfoUser;
                    if (!updateInfo && api && typeof api.getUserInfo === 'function') {
                        try {
                            updateInfo = (await api.getUserInfo(userID))[userID];
                        } catch(e) {
                            updateInfo = null;
                        }
                    }
                    const newData = {
                        name: updateInfo?.name || infoUser.name || "Unknown",
                        vanity: updateInfo?.vanity || infoUser.vanity || null,
                        gender: xGender(updateInfo?.gender) || infoUser.gender || 0
                    };
                    let userData = {
                        ...infoUser,
                        ...newData
                    };
                    userData = await save(userID, userData, "update");
                    resolve(_.cloneDeep(userData));
                }
                catch (err) {
                    reject(err);
                }
            });
        });
    }
    function getAll(path, defaultValue, query) {
        return new Promise((resolve, reject) => {
            taskQueue.push(function () {
                try {
                    let dataReturn = _.cloneDeep(global.db.allUserData || []);
                    if (query && typeof query === "string") {
                        dataReturn = dataReturn.map(uData => fakeGraphql ? fakeGraphql(query, uData) : uData);
                    } else if (query) {
                        throw new CustomError({
                            name: "INVALID_QUERY",
                            message: `The third argument (query) must be a string, not ${typeof query}`
                        });
                    }
                    if (path) {
                        if (!["string", "object"].includes(typeof path)) {
                            throw new CustomError({
                                name: "INVALID_PATH",
                                message: `The first argument (path) must be a string or object, not ${typeof path}`
                            });
                        }
                        if (typeof path === "string") {
                            return resolve(dataReturn.map(uData => _.get(uData, path, defaultValue)));
                        }
                        else if (Array.isArray(path)) {
                            return resolve(dataReturn.map(uData => _.times(path.length, i => _.get(uData, path[i], defaultValue?.[i]))));
                        }
                    }
                    return resolve(dataReturn);
                }
                catch (err) {
                    reject(err);
                }
            });
        });
    }
    async function get_(userID, path, defaultValue, query) {
        if (isNaN(userID)) {
            throw new CustomError({
                name: "INVALID_USER_ID",
                message: `The first argument (userID) must be a number, not ${typeof userID}`
            });
        }
        let userData;
        const index = global.db.allUserData?.findIndex(u => u.userID == userID) ?? -1;
        if (index === -1) {
            userData = await create_(userID);
        } else {
            userData = global.db.allUserData[index];
        }
        if (query && typeof query === "string" && fakeGraphql) {
            userData = fakeGraphql(query, userData);
        } else if (query) {
            throw new CustomError({
                name: "INVALID_QUERY",
                message: `The fourth argument (query) must be a string, not ${typeof query}`
            });
        }
        if (path) {
            if (!["string", "array"].includes(typeof path)) {
                throw new CustomError({
                    name: "INVALID_PATH",
                    message: `The second argument (path) must be a string or array, not ${typeof path}`
                });
            }
            if (typeof path === "string") {
                return _.cloneDeep(_.get(userData, path, defaultValue));
            }
            if (Array.isArray(path)) {
                return _.cloneDeep(_.times(path.length, i => _.get(userData, path[i], defaultValue?.[i])));
            }
        }
        return _.cloneDeep(userData);
    }
    async function get(userID, path, defaultValue, query) {
        return new Promise((resolve, reject) => {
            taskQueue.push(function () {
                get_(userID, path, defaultValue, query)
                    .then(resolve)
                    .catch(reject);
            });
        });
    }
    async function set(userID, updateData, path, query) {
        return new Promise((resolve, reject) => {
            taskQueue.push(async function () {
                try {
                    if (isNaN(userID)) {
                        throw new CustomError({
                            name: "INVALID_USER_ID",
                            message: `The first argument (userID) must be a number, not ${typeof userID}`
                        });
                    }
                    if (!path && (typeof updateData !== "object" || Array.isArray(updateData))) {
                        throw new CustomError({
                            name: "INVALID_UPDATE_DATA",
                            message: `The second argument (updateData) must be an object, not ${typeof updateData}`
                        });
                    }
                    const userData = await save(userID, updateData, "update", path);
                    if (query) {
                        if (typeof query !== "string") {
                            throw new CustomError({
                                name: "INVALID_QUERY",
                                message: `The fourth argument (query) must be a string, not ${typeof query}`
                            });
                        }
                        if (fakeGraphql) {
                            return resolve(_.cloneDeep(fakeGraphql(query, userData)));
                        }
                        return resolve(_.cloneDeep(userData));
                    }

                    return resolve(_.cloneDeep(userData));
                }
                catch (err) {
                    reject(err);
                }
            });
        });
    }
    async function deleteKey(userID, path, query) {
        return new Promise(async function (resolve, reject) {
            taskQueue.push(async function () {
                try {
                    if (isNaN(userID)) {
                        throw new CustomError({
                            name: "INVALID_USER_ID",
                            message: `The first argument (userID) must be a number, not a ${typeof userID}`
                        });
                    }
                    if (typeof path !== "string") {
                        throw new CustomError({
                            name: "INVALID_PATH",
                            message: `The second argument (path) must be a string, not a ${typeof path}`
                        });
                    }
                    const spitPath = path.split(".");
                    if (spitPath.length === 1) {
                        throw new CustomError({
                            name: "INVALID_PATH",
                            message: `Can't delete key "${path}" because it's a root key`
                        });
                    }
                    const parent = spitPath.slice(0, spitPath.length - 1).join(".");
                    const parentData = await get_(userID, parent);
                    if (!parentData) {
                        throw new CustomError({
                            name: "INVALID_PATH",
                            message: `Can't find key "${parent}" in user with userID: ${userID}`
                        });
                    }
                    _.unset(parentData, spitPath[spitPath.length - 1]);
                    const setData = await save(userID, parentData, "update", parent);
                    if (query) {
                        if (typeof query !== "string") {
                            throw new CustomError({
                                name: "INVALID_QUERY",
                                message: `The fourth argument (query) must be a string, not a ${typeof query}`
                            });
                        }
                        if (fakeGraphql) {
                            return resolve(_.cloneDeep(fakeGraphql(query, setData)));
                        }
                        return resolve(_.cloneDeep(setData));
                    }
                    return resolve(_.cloneDeep(setData));
                }
                catch (err) {
                    reject(err);
                }
            });
        });
    }
    async function getMoney(userID) {
        return new Promise((resolve, reject) => {
            taskQueue.push(async function () {
                try {
                    if (isNaN(userID)) {
                        throw new CustomError({
                            name: "INVALID_USER_ID",
                            message: `The first argument (userID) must be a number, not ${typeof userID}`
                        });
                    }
                    const money = await get_(userID, "money");
                    resolve(money);
                }
                catch (err) {
                    reject(err);
                }
            });
        });
    }
    async function addMoney(userID, money, query) {
        return new Promise((resolve, reject) => {
            taskQueue.push(async function () {
                try {
                    if (isNaN(userID)) {
                        throw new CustomError({
                            name: "INVALID_USER_ID",
                            message: `The first argument (userID) must be a number, not ${typeof userID}`
                        });
                    }
                    if (isNaN(money)) {
                        throw new CustomError({
                            name: "INVALID_MONEY",
                            message: `The second argument (money) must be a number, not ${typeof money}`
                        });
                    }
                    if (!global.db.allUserData?.some(u => u.userID == userID)) {
                        await create_(userID);
                    }
                    const currentMoney = await get_(userID, "money");
                    const newMoney = currentMoney + money;
                    const userData = await save(userID, newMoney, "update", "money");
                    if (query) {
                        if (typeof query !== "string") {
                            throw new CustomError({
                                name: "INVALID_QUERY",
                                message: `The third argument (query) must be a string, not ${typeof query}`
                            });
                        }
                        if (fakeGraphql) {
                            return resolve(_.cloneDeep(fakeGraphql(query, userData)));
                        }
                        return resolve(_.cloneDeep(userData));
                    }
                    return resolve(_.cloneDeep(userData));
                }
                catch (err) {
                    reject(err);
                }
            });
        });
    }
    async function subtractMoney(userID, money, query) {
        return new Promise((resolve, reject) => {
            taskQueue.push(async function () {
                try {
                    if (isNaN(userID)) {
                        throw new CustomError({
                            name: "INVALID_USER_ID",
                            message: `The first argument (userID) must be a number, not ${typeof userID}`
                        });
                    }
                    if (isNaN(money)) {
                        throw new CustomError({
                            name: "INVALID_MONEY",
                            message: `The second argument (money) must be a number, not ${typeof money}`
                        });
                    }
                    if (!global.db.allUserData?.some(u => u.userID == userID)) {
                        await create_(userID);
                    }
                    const currentMoney = await get_(userID, "money");
                    const newMoney = currentMoney - money;
                    const userData = await save(userID, newMoney, "update", "money");
                    if (query) {
                        if (typeof query !== "string") {
                            throw new CustomError({
                                name: "INVALID_QUERY",
                                message: `The third argument (query) must be a string, not ${typeof query}`
                            });
                        }
                        if (fakeGraphql) {
                            return resolve(_.cloneDeep(fakeGraphql(query, userData)));
                        }
                        return resolve(_.cloneDeep(userData));
                    }
                    return resolve(_.cloneDeep(userData));
                }
                catch (err) {
                    reject(err);
                }
            });
        });
    }
    async function remove(userID) {
        return new Promise((resolve, reject) => {
            taskQueue.push(async function () {
                try {
                    if (isNaN(userID)) {
                        throw new CustomError({
                            name: "INVALID_USER_ID",
                            message: `The first argument (userID) must be a number, not ${typeof userID}`
                        });
                    }
                    await save(userID, { userID }, "remove");
                    return resolve(true);
                }
                catch (err) {
                    reject(err);
                }
            });
        });
    }
    return {
        existsSync: function existsSync(userID) {
            return global.db.allUserData?.some(u => u.userID == userID) ?? false;
        },
        getName,
        getNameInDB,
        getAvatarUrl,
        create,
        refreshInfo,
        getAll,
        get,
        set,
        deleteKey,
        getMoney,
        addMoney,
        subtractMoney,
        remove
    };
};
