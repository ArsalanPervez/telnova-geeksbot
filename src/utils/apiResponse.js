const sendResponse = (res, statusCode, success, message, data = null) => {
  const response = {
    success,
    message,
  };

  if (data !== null) {
    response.data = data;
  }

  return res.status(statusCode).json(response);
};

const success = (res, message, data = null, statusCode = 200) => {
  return sendResponse(res, statusCode, true, message, data);
};

const created = (res, message, data = null) => {
  return sendResponse(res, 201, true, message, data);
};

const error = (res, message, statusCode = 400) => {
  return sendResponse(res, statusCode, false, message);
};

const validationError = (res, errors) => {
  return res.status(422).json({
    success: false,
    message: 'Validation failed',
    errors,
  });
};

module.exports = {
  sendResponse,
  success,
  created,
  error,
  validationError,
};
