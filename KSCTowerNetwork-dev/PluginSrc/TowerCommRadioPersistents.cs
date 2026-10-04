using System;
using System.Reflection;
using UnityEngine;

namespace KSCTowerNetwork
{
    /// <summary>
    /// Shared RPM RasterPropMonitorComputer + MAS MASFlightComputer per-part persistent access
    /// for ASET COMM radio hooks.
    /// </summary>
    public static class TowerCommRadioPersistents
    {
        private static MethodInfo _rpmGetPersistent;
        private static MethodInfo _rpmSetPersistent;
        private static Type _rpmCachedType;
        private static MethodInfo _masGetPersistent;
        private static MethodInfo _masSetPersistent;
        private static Type _masCachedType;

        public static object Read(Part part, string name)
        {
            if (part == null || string.IsNullOrEmpty(name))
            {
                return null;
            }

            for (int i = 0; i < part.Modules.Count; i++)
            {
                var mod = part.Modules[i];
                if (mod == null)
                {
                    continue;
                }

                var t = mod.GetType();

                if (t.FullName == "JSI.RasterPropMonitorComputer")
                {
                    if (_rpmGetPersistent == null || _rpmCachedType != t)
                    {
                        _rpmGetPersistent = ResolveMethod(t, "GetPersistentVariable", 3);
                        _rpmSetPersistent = ResolveMethod(t, "SetPersistentVariable", 3);
                        _rpmCachedType = t;
                    }

                    if (_rpmGetPersistent != null)
                    {
                        try
                        {
                            var r = _rpmGetPersistent.Invoke(mod, new object[] { name, null, false });
                            // Do not treat null as authoritative: RPM often returns null for "unset"
                            // while MAS on the same part still holds the value (module order varies).
                            if (r != null)
                            {
                                return r;
                            }
                        }
                        catch
                        {
                            // RPM throws on unknown vars in some versions
                        }
                    }
                }

                if (t.FullName == "AvionicsSystems.MASFlightComputer")
                {
                    if (_masGetPersistent == null || _masCachedType != t)
                    {
                        _masGetPersistent = ResolveMethod(t, "GetPersistent", 1);
                        _masSetPersistent = ResolveMethod(t, "SetPersistent", 2);
                        _masCachedType = t;
                    }

                    if (_masGetPersistent != null)
                    {
                        try
                        {
                            var r = _masGetPersistent.Invoke(mod, new object[] { name });
                            if (r != null)
                            {
                                return r;
                            }
                        }
                        catch
                        {
                        }
                    }
                }
            }

            return null;
        }

        /// <summary>Writes to every RPM + MAS computer on the part (best-effort).</summary>
        public static bool Write(Part part, string name, double value)
        {
            if (part == null || string.IsNullOrEmpty(name))
            {
                return false;
            }

            bool wrote = false;
            for (int i = 0; i < part.Modules.Count; i++)
            {
                var mod = part.Modules[i];
                if (mod == null)
                {
                    continue;
                }

                var t = mod.GetType();

                if (t.FullName == "JSI.RasterPropMonitorComputer")
                {
                    if (_rpmSetPersistent == null || _rpmCachedType != t)
                    {
                        _rpmGetPersistent = ResolveMethod(t, "GetPersistentVariable", 3);
                        _rpmSetPersistent = ResolveMethod(t, "SetPersistentVariable", 3);
                        _rpmCachedType = t;
                    }

                    if (_rpmSetPersistent != null)
                    {
                        try
                        {
                            _rpmSetPersistent.Invoke(mod, new object[] { name, (float)value, false });
                            wrote = true;
                        }
                        catch (Exception ex)
                        {
                            Debug.LogWarning("[KSCTowerNetwork] RPM SetPersistentVariable threw: " + ex);
                        }
                    }
                }

                if (t.FullName == "AvionicsSystems.MASFlightComputer")
                {
                    if (_masSetPersistent == null || _masCachedType != t)
                    {
                        _masGetPersistent = ResolveMethod(t, "GetPersistent", 1);
                        _masSetPersistent = ResolveMethod(t, "SetPersistent", 2);
                        _masCachedType = t;
                    }

                    if (_masSetPersistent != null)
                    {
                        try
                        {
                            _masSetPersistent.Invoke(mod, new object[] { name, value });
                            wrote = true;
                        }
                        catch (Exception ex)
                        {
                            Debug.LogWarning("[KSCTowerNetwork] MAS SetPersistent threw: " + ex);
                        }
                    }
                }
            }

            return wrote;
        }

        private static MethodInfo ResolveMethod(Type t, string methodName, int paramCount)
        {
            var methods = t.GetMethods(BindingFlags.Instance | BindingFlags.Public);
            for (int i = 0; i < methods.Length; i++)
            {
                var m = methods[i];
                if (m.Name == methodName && m.GetParameters().Length == paramCount)
                {
                    return m;
                }
            }

            return null;
        }
    }
}
