// request-logger.ts — Console logging middleware (sink: log)
import { Request, Response, NextFunction } from 'express';
import { getPatient } from './patient-service';

export function requestLogger(req: Request, _res: Response, next: NextFunction) {
  const patientId = req.params.patientId;
  if (patientId) {
    const patient = getPatient(patientId);
    console.log('[REQUEST]', {
      method: req.method,
      url: req.url,
      patientData: patient,
      body: req.body,
      timestamp: new Date().toISOString(),
    });
  }
  next();
}
