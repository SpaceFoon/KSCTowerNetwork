using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// "Park at KSC tower" — snaps the active camera to a vantage on top of the KSC tower so
    /// the player can immediately see the ghost fleet (and any KSC-TOWER-* hullcam streams)
    /// without manually orbiting there. A second press un-parks and restores whatever pose
    /// the camera had before we touched it (toggle behaviour).
    ///
    /// <para><b>Current build:</b> the feature is turned off via
    /// <see cref="TowerParkKscTwrEnabled"/> because moving <see cref="Camera.main"/> and
    /// reflectively patching <c>SpaceCenterCamera2</c> still left the Space Centre / tracking
    /// camera in a broken state for many players. See <c>docs/DISABLED_FEATURES.md</c>.</para>
    ///
    /// We deliberately do NOT spawn a vessel or change scenes; that would interact badly with
    /// flights in progress. Instead we move whichever <see cref="Camera.main"/> is active and
    /// — when in Space Centre — also nudge KSP's <c>SpaceCenterCamera2</c> via reflection so
    /// the next user input doesn't snap us back to wherever the camera was. Crucially we set
    /// the orbital camera's <c>pivot</c> / <c>pivotTranslate</c> fields, not just its
    /// transform, because the orbital math recomputes <c>transform.position</c> from the
    /// pivot every frame; without that the view ends up "all messed up" the moment the user
    /// drags the mouse.
    ///
    /// Tower-top coordinates are pulled from KSP's stock KSC layout: lat/lon are the Mission
    /// Control building, altitude is well above the parapet so the camera looks DOWN at the
    /// runway, SPH apron, and ghost-fleet vessels rather than ending up inside the geometry.
    /// </summary>
    public static class TowerJumpToWindow
    {
        /// <summary>
        /// Master switch for the radio footer "Park at KSC tower" action. Set to <c>true</c>
        /// only after the camera / SpaceCenterCamera2 path is verified stable on target KSP builds.
        /// Stored as <c>static readonly</c> (not <c>const</c>) so turning it off does not make the
        /// implementation bodies look unreachable to the C# compiler.
        /// </summary>
        internal static readonly bool TowerParkKscTwrEnabled = false;

        /// <summary>Approximate latitude of the KSC tower (degrees).</summary>
        private const double TowerLat = -0.0907;
        /// <summary>Approximate longitude of the KSC tower (degrees).</summary>
        private const double TowerLon = -74.5577;
        /// <summary>Camera altitude (m ASL). High enough to clear all KSC roofs and look DOWN at the field.</summary>
        private const double TowerAslMeters = 130.0;
        /// <summary>Heading the camera initially looks toward (deg, clockwise from north). Faces the runway.</summary>
        private const float InitialHeading = 90f;
        /// <summary>Pitch in degrees — positive looks down. Tilts the orbital camera toward the apron.</summary>
        private const float InitialPitch = 25f;
        /// <summary>Orbit radius in metres for SpaceCenterCamera2 — small so we sit basically AT the tower.</summary>
        private const float InitialDistance = 2f;

        // ── toggle state ────────────────────────────────────────────────────────────
        // We snapshot the camera pose (and the SpaceCenterCamera2 orbital fields, when
        // present) the first time the user parks. A second click restores the snapshot
        // and clears _isParked so the next click parks again. Anything we couldn't
        // snapshot is silently ignored on restore — the goal is "best-effort un-do",
        // not bulletproof state management across scene loads.
        private static bool _isParked;
        private static Vector3 _savedCamPos;
        private static Quaternion _savedCamRot;
        private static readonly Dictionary<string, object> _savedScFields = new Dictionary<string, object>();
        private static Vector3 _savedScPos;
        private static Quaternion _savedScRot;
        private static bool _savedScHasTransform;

        /// <summary>True iff the camera is currently parked at the tower (i.e. the next click un-parks).</summary>
        public static bool IsParked
        {
            get { return _isParked; }
        }

        /// <summary>
        /// True when there's something we can plausibly aim the camera at — i.e. we're in a
        /// scene that has a main camera and a Kerbin <see cref="CelestialBody"/> available.
        /// </summary>
        public static bool IsAvailable
        {
            get
            {
                try
                {
                    if (!TowerParkKscTwrEnabled)
                    {
                        return false;
                    }
                    return Camera.main != null && HomeBody() != null;
                }
                catch (Exception)
                {
                    return false;
                }
            }
        }

        /// <summary>
        /// Toggle the tower-park view. First call snapshots the camera and jumps to the tower;
        /// second call restores the snapshot. Returns a one-line status string suitable for the
        /// radio panel's <c>_statusLine</c>.
        /// </summary>
        public static string JumpToTower()
        {
            if (!TowerParkKscTwrEnabled)
            {
                return "Park at KSC tower is off in this build (camera issues) — see docs/DISABLED_FEATURES.md.";
            }
            if (_isParked)
            {
                return UnparkFromTower();
            }
            return ParkAtTower();
        }

        private static string ParkAtTower()
        {
            var home = HomeBody();
            if (home == null)
            {
                return "Park at KSC tower: no Kerbin reference (is this scene loaded?).";
            }

            try
            {
                var worldPos = home.GetWorldSurfacePosition(TowerLat, TowerLon, TowerAslMeters);
                var up = home.GetSurfaceNVector(TowerLat, TowerLon).normalized;
                var north = (home.GetWorldSurfacePosition(TowerLat + 0.001, TowerLon, TowerAslMeters)
                             - worldPos).normalized;
                var fwd = Quaternion.AngleAxis(InitialHeading, up) * north;
                // Tilt the look-direction down by InitialPitch so the camera frames the
                // runway/apron instead of staring at the horizon. We rotate around the
                // local "right" axis (cross of fwd & up) so heading is preserved.
                var right = Vector3.Cross(fwd, up).normalized;
                var lookDir = Quaternion.AngleAxis(InitialPitch, right) * fwd;

                var cam = Camera.main;
                if (cam == null)
                {
                    return "Park at KSC tower: no main camera in this scene.";
                }

                _savedCamPos = cam.transform.position;
                _savedCamRot = cam.transform.rotation;

                cam.transform.position = worldPos;
                cam.transform.rotation = Quaternion.LookRotation(lookDir, up);

                TryAnchorSpaceCenterCamera(worldPos, up);

                _isParked = true;
                return "Parked at KSC tower (click again to exit).";
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] JumpToTower failed: " + ex);
                _isParked = false;
                return "Park at KSC tower failed (see KSP.log).";
            }
        }

        private static string UnparkFromTower()
        {
            try
            {
                var cam = Camera.main;
                if (cam != null)
                {
                    cam.transform.position = _savedCamPos;
                    cam.transform.rotation = _savedCamRot;
                }

                TryRestoreSpaceCenterCamera();
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[KSCTowerNetwork] UnparkFromTower failed: " + ex);
            }
            finally
            {
                _isParked = false;
                _savedScFields.Clear();
                _savedScHasTransform = false;
            }
            return "Exited KSC tower view.";
        }

        private static CelestialBody HomeBody()
        {
            try
            {
                return Planetarium.fetch != null ? Planetarium.fetch.Home : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// Best-effort: find a <c>SpaceCenterCamera2</c> instance in the scene and write the
        /// pose into whichever public/serialised fields it exposes. We push the world position
        /// into the orbital camera's <c>pivot</c> transform AND the local <c>pivotTranslate</c>
        /// field — the orbital math recomputes the camera transform every frame from the pivot,
        /// so writing only <c>transform.position</c> is what makes the previous version's view
        /// snap back to garbage on the user's next mouse drag. We also pin pitch/heading and
        /// drop <c>distance</c> so we sit basically AT the tower instead of orbiting 12 m out.
        /// Anything missing is silently skipped — the goal is "make the snap stick when KSP's
        /// stock Space Centre camera is present" without coupling to a specific KSP build.
        /// </summary>
        private static void TryAnchorSpaceCenterCamera(Vector3 worldPos, Vector3 up)
        {
            _savedScFields.Clear();
            _savedScHasTransform = false;
            try
            {
                var type = Type.GetType("SpaceCenterCamera2, Assembly-CSharp");
                if (type == null)
                {
                    return;
                }

                var instances = UnityEngine.Object.FindObjectsOfType(type);
                if (instances == null || instances.Length == 0)
                {
                    return;
                }

                var inst = instances[0] as MonoBehaviour;
                if (inst == null)
                {
                    return;
                }

                _savedScPos = inst.transform.position;
                _savedScRot = inst.transform.rotation;
                _savedScHasTransform = true;

                inst.transform.position = worldPos;
                inst.transform.rotation = Quaternion.LookRotation(Vector3.Cross(up, Vector3.up), up);

                // The orbital pivot is what *actually* anchors the view — without writing it
                // KSP recomputes transform.position next FixedUpdate from the stale pivot and
                // we end up looking at the old vantage from a tilted angle.
                TryWritePivotTransform(inst, type, worldPos);
                TryWriteVector3Field(inst, type, "pivotTranslate", worldPos);
                TryWriteVector3Field(inst, type, "initialPivotPosition", worldPos);

                TryWriteFloatField(inst, type, "pitch", InitialPitch);
                TryWriteFloatField(inst, type, "heading", InitialHeading);
                TryWriteFloatField(inst, type, "distance", InitialDistance);
                TryWriteFloatField(inst, type, "startDistance", InitialDistance);
            }
            catch (Exception ex)
            {
                Debug.Log("[KSCTowerNetwork] anchor SpaceCenterCamera2 skipped: " + ex.Message);
            }
        }

        private static void TryRestoreSpaceCenterCamera()
        {
            try
            {
                var type = Type.GetType("SpaceCenterCamera2, Assembly-CSharp");
                if (type == null)
                {
                    return;
                }

                var instances = UnityEngine.Object.FindObjectsOfType(type);
                if (instances == null || instances.Length == 0)
                {
                    return;
                }

                var inst = instances[0] as MonoBehaviour;
                if (inst == null)
                {
                    return;
                }

                if (_savedScHasTransform)
                {
                    inst.transform.position = _savedScPos;
                    inst.transform.rotation = _savedScRot;
                }

                const BindingFlags bf = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
                foreach (var kv in _savedScFields)
                {
                    var f = type.GetField(kv.Key, bf);
                    if (f == null)
                    {
                        continue;
                    }
                    try
                    {
                        f.SetValue(inst, kv.Value);
                    }
                    catch (Exception)
                    {
                        // Type drift between KSP versions — skip silently.
                    }
                }

                // Also restore the pivot transform position if we tracked it.
                object savedPivotPos;
                if (_savedScFields.TryGetValue("__pivot.position", out savedPivotPos) && savedPivotPos is Vector3)
                {
                    var pivotField = type.GetField("pivot", bf);
                    if (pivotField != null)
                    {
                        var pivot = pivotField.GetValue(inst) as Transform;
                        if (pivot != null)
                        {
                            pivot.position = (Vector3)savedPivotPos;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Debug.Log("[KSCTowerNetwork] restore SpaceCenterCamera2 skipped: " + ex.Message);
            }
        }

        private static void TryWritePivotTransform(object inst, Type type, Vector3 worldPos)
        {
            const BindingFlags bf = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
            var pivotField = type.GetField("pivot", bf);
            if (pivotField == null)
            {
                return;
            }
            var pivot = pivotField.GetValue(inst) as Transform;
            if (pivot == null)
            {
                return;
            }
            _savedScFields["__pivot.position"] = pivot.position;
            pivot.position = worldPos;
        }

        private static void TryWriteVector3Field(object inst, Type type, string fieldName, Vector3 value)
        {
            const BindingFlags bf = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
            var f = type.GetField(fieldName, bf);
            if (f != null && f.FieldType == typeof(Vector3))
            {
                _savedScFields[fieldName] = f.GetValue(inst);
                f.SetValue(inst, value);
            }
        }

        private static void TryWriteFloatField(object inst, Type type, string fieldName, float value)
        {
            const BindingFlags bf = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
            var f = type.GetField(fieldName, bf);
            if (f == null || (f.FieldType != typeof(float) && f.FieldType != typeof(double)))
            {
                return;
            }
            _savedScFields[fieldName] = f.GetValue(inst);
            if (f.FieldType == typeof(float))
            {
                f.SetValue(inst, value);
            }
            else
            {
                f.SetValue(inst, (double)value);
            }
        }
    }
}
