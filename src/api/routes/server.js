const express = require('express');
const serverController = require('../controllers/server');

module.exports = (context) => {
  let router = express.Router();
  //  这个是获取服务器信息的接口
  router.get('/', serverController.getInfo.bind(context));
  return router;
};
