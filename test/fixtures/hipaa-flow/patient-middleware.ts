// patient-middleware.ts — Express middleware (transform, middleware-next)
import { Request, Response, NextFunction } from 'express';
import { getPatient } from './patient-service';

export async function attachPatient(req: Request, res: Response, next: NextFunction) {
  const patientId = req.params.patientId;
  if (!patientId) {
    return res.status(400).json({ error: 'Missing patientId' });
  }

  try {
    const patient = await getPatient(patientId);
    (req as any).patient = patient;
    next();
  } catch (err) {
    next(err);
  }
}
